import { Component, ElementRef, ViewChild } from '@angular/core';
import { ChatMessageTargetContext } from '@udonarium/chat-message';
import { ChatTab } from '@udonarium/chat-tab';
import { ImageStorage } from '@udonarium/core/file-storage/image-storage';
import { ObjectStore } from '@udonarium/core/synchronize-object/object-store';
import { EventSystem } from '@udonarium/core/system';
import { DiceBot } from '@udonarium/dice-bot';
import { GameCharacter } from '@udonarium/game-character';
import { PeerCursor } from '@udonarium/peer-cursor';
import { FileSelecterComponent } from 'component/file-selecter/file-selecter.component';
import { ChatMessageService } from 'service/chat-message.service';
import { ModalService } from 'service/modal.service';
import { TabletopService } from 'service/tabletop.service';

interface MacroHotbarSlot {
  label: string;
  text: string;
  iconIdentifier: string;
}

interface MacroHotbarSettings {
  selectedCharacterIdentifier: string;
  targetMode: boolean;
  activePage: number;
}

const STORAGE_KEY = 'udonarium.macroHotbar.v1';
const SETTINGS_STORAGE_KEY = 'udonarium.macroHotbar.settings.v1';
const VISIBILITY_STORAGE_KEY = 'udonarium.macroHotbar.visible.v1';
const SLOT_COUNT = 12;
const PAGE_COUNT = 5;
const TOTAL_SLOT_COUNT = SLOT_COUNT * PAGE_COUNT;

@Component({
  selector: 'macro-hotbar',
  templateUrl: './macro-hotbar.component.html',
  styleUrls: ['./macro-hotbar.component.css']
})
export class MacroHotbarComponent {
  @ViewChild('importFileInput') importFileInput: ElementRef<HTMLInputElement>;

  slots: MacroHotbarSlot[] = this.loadSlots();
  editingIndex: number = -1;
  editSlot: MacroHotbarSlot = this.emptySlot();
  private settings: MacroHotbarSettings = this.loadSettings();
  selectedCharacterIdentifier = this.settings.selectedCharacterIdentifier;
  targetMode = this.settings.targetMode;
  activePage = this.settings.activePage;
  isVisible = this.loadVisibility();
  get isExtendedDiceBotEnabled(): boolean { return this.tabletopService.currentTable?.extendedDiceBotEnabled ?? false; }
  helpText = '';
  hoverSlotLabel = '';
  hoverSlotText = '';

  constructor(
    public chatMessageService: ChatMessageService,
    private modalService: ModalService,
    private tabletopService: TabletopService
  ) {
    EventSystem.register(this)
      .on('MACRO_HOTBAR_VISIBILITY_CHANGED', event => {
        this.isVisible = !!event.data.visible;
      })
      .on('IACHARA_HOTBAR_IMPORT', event => {
        this.importIacharaHotbar(event.data || {});
      });
  }

  ngOnDestroy() {
    EventSystem.unregister(this);
  }

  getIconUrl(slot: MacroHotbarSlot): string {
    if (!slot.iconIdentifier) return '';
    const image = ImageStorage.instance.get(slot.iconIdentifier);
    return image ? image.url : '';
  }

  get selectedCharacter(): GameCharacter {
    const object = ObjectStore.instance.get(this.selectedCharacterIdentifier);
    return object instanceof GameCharacter ? object : null;
  }

  get selectedCharacterImageUrl(): string {
    const character = this.selectedCharacter;
    if (!character) return '';
    const imageElement = character.imageDataElement && character.imageDataElement.children.length > character.selectedTachieNum
      ? character.imageDataElement.children[character.selectedTachieNum]
      : null;
    const image = imageElement ? ImageStorage.instance.get(<string>imageElement.value) : character.imageFile;
    return image ? image.url : '';
  }

  get pageNumbers(): number[] { return Array.from({ length: PAGE_COUNT }, (_, i) => i); }

  get visibleSlots(): MacroHotbarSlot[] {
    const start = this.activePage * SLOT_COUNT;
    return this.slots.slice(start, start + SLOT_COUNT);
  }

  getSlotTooltip(slot: MacroHotbarSlot): string {
    if (!slot.text.trim().length) return '空スロット: クリックで編集 / Ctrl+クリックで編集';
    const label = (slot.label || '').trim() || '名称なし';
    return `${label}\n${slot.text}`;
  }

  showSlotPopover(slot: MacroHotbarSlot) {
    this.hoverSlotLabel = (slot.label || '').trim() || (slot.text.trim().length ? '名称なし' : '空スロット');
    this.hoverSlotText = slot.text.trim().length ? slot.text : 'クリックで編集 / Ctrl+クリックで編集';
  }

  hideSlotPopover() {
    this.hoverSlotLabel = '';
    this.hoverSlotText = '';
  }

  saveSettings() {
    try {
      localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({
        selectedCharacterIdentifier: this.selectedCharacterIdentifier || '',
        targetMode: this.targetMode,
        activePage: this.activePage
      }));
    } catch (e) {
      console.warn('macro hotbar settings save failed', e);
    }
  }

  setActivePage(page: number) {
    this.activePage = Math.max(0, Math.min(PAGE_COUNT - 1, page));
    this.saveSettings();
    this.cancelEdit();
  }

  toggleTargetMode() {
    this.targetMode = !this.targetMode;
    this.saveSettings();
    this.helpText = this.targetMode ? 'ターゲット対象モードON' : 'ターゲット対象モードOFF';
  }

  setTargetedCharacterAsSelf() {
    const targets = this.targetedGameCharacterList();
    if (targets.length < 1) {
      this.helpText = 'Altで対象にしたコマがありません';
      return;
    }
    this.selectedCharacterIdentifier = targets[0].identifier;
    this.saveSettings();
    this.helpText = `${targets[0].name || 'コマ'}を自キャラにしました`;
  }

  clearSelectedCharacter() {
    this.selectedCharacterIdentifier = '';
    this.saveSettings();
    this.helpText = '自キャラ設定を解除しました';
  }

  onSlotClick(event: MouseEvent, visibleIndex: number) {
    event.preventDefault();
    event.stopPropagation();
    const index = this.toSlotIndex(visibleIndex);

    if (event.ctrlKey || event.metaKey) {
      this.startEdit(index);
      return;
    }

    const slot = this.slots[index];
    if (!slot.text.trim().length) {
      this.startEdit(index);
      return;
    }

    this.sendMacro(slot);
  }

  onSlotContextMenu(event: MouseEvent, visibleIndex: number) {
    event.preventDefault();
    event.stopPropagation();
    const index = this.toSlotIndex(visibleIndex);

    const slot = this.slots[index];
    if (!slot.text.trim().length) {
      this.startEdit(index);
      return;
    }

    this.copyText(slot.text);
  }

  startEdit(index: number) {
    this.editingIndex = index;
    this.editSlot = { ...this.slots[index] };
    this.helpText = `ページ${this.activePage + 1} スロット${(index % SLOT_COUNT) + 1}を編集中`;
  }

  saveEdit() {
    if (this.editingIndex < 0) return;
    this.slots[this.editingIndex] = {
      label: (this.editSlot.label || '').trim(),
      text: this.editSlot.text || '',
      iconIdentifier: this.editSlot.iconIdentifier || ''
    };
    this.saveSlots();
    this.helpText = `スロット${this.editingIndex + 1}を保存しました`;
    this.cancelEdit();
  }

  clearEdit() {
    if (this.editingIndex < 0) return;
    this.slots[this.editingIndex] = this.emptySlot();
    this.saveSlots();
    this.helpText = `スロット${this.editingIndex + 1}を空にしました`;
    this.cancelEdit();
  }

  cancelEdit() {
    this.editingIndex = -1;
    this.editSlot = this.emptySlot();
  }

  selectIcon() {
    this.modalService.open<string>(FileSelecterComponent, { isAllowedEmpty: true }).then(value => {
      if (value == null) return;
      this.editSlot.iconIdentifier = value;
    });
  }

  clearIcon() {
    this.editSlot.iconIdentifier = '';
  }

  exportSlots() {
    const data = JSON.stringify({ version: 2, pageCount: PAGE_COUNT, slotCount: SLOT_COUNT, slots: this.slots }, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'udonarium-macro-hotbar.json';
    anchor.click();
    URL.revokeObjectURL(url);
    this.helpText = 'ホットバー設定を書き出しました';
  }

  openImportDialog() {
    if (!this.importFileInput || !this.importFileInput.nativeElement) return;
    this.importFileInput.nativeElement.value = '';
    this.importFileInput.nativeElement.click();
  }

  importSlots(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files && input.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(String(reader.result || '{}'));
        const imported = Array.isArray(data) ? data : data.slots;
        if (!Array.isArray(imported)) throw new Error('slots is not array');
        this.slots = this.normalizeSlots(imported);
        this.saveSlots();
        this.helpText = 'ホットバー設定を読み込みました';
      } catch (e) {
        console.warn('macro hotbar import failed', e);
        this.helpText = '読み込みに失敗しました';
      }
    };
    reader.readAsText(file);
  }

  private sendMacro(slot: MacroHotbarSlot) {
    const chatTab: ChatTab = this.chatMessageService.chatTabs && this.chatMessageService.chatTabs[0];
    if (!chatTab) {
      this.helpText = '送信先チャットタブがありません';
      return;
    }

    const character = this.selectedCharacter;
    const palette = character ? character.chatPalette : null;
    const sendFrom = character ? character.identifier : (PeerCursor.myCursor ? PeerCursor.myCursor.identifier : '');
    const gameType = palette ? palette.dicebot : '';
    const tachieNum = character ? character.selectedTachieNum : 0;
    const messageColor = character && character.chatColorCode && character.chatColorCode.length ? character.chatColorCode[0] : '#000000';

    DiceBot.loadGameSystemAsync(gameType).then(gameSystem => {
      let text = slot.text;
      let messageTargetContext: ChatMessageTargetContext[] = null;

      if (character && palette) {
        const useTarget = this.targetMode || palette.checkTargetCharactor(slot.text);
        if (useTarget) {
          const targets = this.targetedGameCharacterList();
          if (targets.length < 1) {
            this.helpText = '対象が未選択です';
            return;
          }

          const evaluatedTexts: string[] = [];
          messageTargetContext = [];
          let first = true;
          for (let target of targets) {
            const macroText = first ? slot.text : DiceBot.deleteMyselfResourceBuff(slot.text);
            const evaluated = palette.evaluate(macroText, character.rootDataElement, target, this.isExtendedDiceBotEnabled);
            evaluatedTexts.push(`${evaluated} [${target.name}]`);
            messageTargetContext.push({ text: evaluated, object: target });
            first = false;
          }
          text = evaluatedTexts.join('\n');
        } else {
          text = palette.evaluate(slot.text, character.rootDataElement, null, this.isExtendedDiceBotEnabled);
          messageTargetContext = [{ text: text, object: null }];
        }
      }

      this.chatMessageService.sendMessage(chatTab, text, gameSystem, sendFrom, '', tachieNum, messageColor, messageTargetContext);
      this.helpText = `${slot.label || 'マクロ'}を送信しました`;
    });
  }

  private targeted(gameCharacter: GameCharacter): boolean {
    if (gameCharacter.location.name != 'table') return false;
    return gameCharacter.targeted;
  }

  private targetedGameCharacterList(): GameCharacter[] {
    return ObjectStore.instance
      .getObjects<GameCharacter>(GameCharacter)
      .filter(character => this.targeted(character));
  }

  private copyText(text: string) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => {
        this.helpText = 'マクロをコピーしました';
      }).catch(() => this.fallbackCopyText(text));
    } else {
      this.fallbackCopyText(text);
    }
  }

  private fallbackCopyText(text: string) {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
    this.helpText = 'マクロをコピーしました';
  }

  private loadSlots(): MacroHotbarSlot[] {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return this.emptySlots();
      const data = JSON.parse(raw);
      const slots = Array.isArray(data) ? data : data.slots;
      return this.normalizeSlots(slots);
    } catch (e) {
      console.warn('macro hotbar load failed', e);
      return this.emptySlots();
    }
  }

  private importIacharaHotbar(data: any) {
    const imported = Array.isArray(data.slots) ? data.slots : [];
    if (imported.length < 1) return;

    const slots = imported
      .map(slot => ({
        label: String(slot && slot.label || '').trim(),
        text: String(slot && slot.text || '').trim(),
        iconIdentifier: String(slot && slot.iconIdentifier || '')
      }))
      .filter(slot => slot.text.length > 0);
    if (slots.length < 1) return;

    let writeIndex = this.slots.findIndex(slot => !slot.text.trim().length);
    if (writeIndex < 0) writeIndex = 0;
    const startIndex = writeIndex;

    for (let slot of slots) {
      if (writeIndex >= TOTAL_SLOT_COUNT) break;
      this.slots[writeIndex++] = slot;
    }

    this.selectedCharacterIdentifier = String(data.characterIdentifier || this.selectedCharacterIdentifier || '');
    this.activePage = Math.floor(startIndex / SLOT_COUNT);
    this.saveSlots();
    this.saveSettings();
    this.isVisible = true;
    try { localStorage.setItem(VISIBILITY_STORAGE_KEY, '1'); } catch (e) { }
    this.helpText = `${data.characterName || 'コマ'}のCoC判定を${writeIndex - startIndex}個登録しました`;
  }

  private loadVisibility(): boolean {
    try {
      const raw = localStorage.getItem(VISIBILITY_STORAGE_KEY);
      return raw == null ? true : raw === '1';
    } catch (e) {
      return true;
    }
  }

  private loadSettings(): MacroHotbarSettings {
    try {
      const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
      if (!raw) return { selectedCharacterIdentifier: '', targetMode: false, activePage: 0 };
      const data = JSON.parse(raw);
      return {
        selectedCharacterIdentifier: String(data.selectedCharacterIdentifier || ''),
        targetMode: !!data.targetMode,
        activePage: Math.max(0, Math.min(PAGE_COUNT - 1, Number(data.activePage || 0)))
      };
    } catch (e) {
      console.warn('macro hotbar settings load failed', e);
      return { selectedCharacterIdentifier: '', targetMode: false, activePage: 0 };
    }
  }

  private saveSlots() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 2, pageCount: PAGE_COUNT, slotCount: SLOT_COUNT, slots: this.slots }));
    } catch (e) {
      console.warn('macro hotbar save failed', e);
      this.helpText = '保存に失敗しました';
    }
  }

  private normalizeSlots(slots: any[]): MacroHotbarSlot[] {
    const normalized = this.emptySlots();
    for (let i = 0; i < Math.min(TOTAL_SLOT_COUNT, slots ? slots.length : 0); i++) {
      normalized[i] = {
        label: String(slots[i] && slots[i].label || ''),
        text: String(slots[i] && slots[i].text || ''),
        iconIdentifier: String(slots[i] && (slots[i].iconIdentifier || slots[i].iconUrl) || '')
      };
    }
    return normalized;
  }

  private emptySlots(): MacroHotbarSlot[] {
    return Array.from({ length: TOTAL_SLOT_COUNT }, () => this.emptySlot());
  }

  private emptySlot(): MacroHotbarSlot {
    return { label: '', text: '', iconIdentifier: '' };
  }

  private toSlotIndex(visibleIndex: number): number {
    return this.activePage * SLOT_COUNT + visibleIndex;
  }
}
