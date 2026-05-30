import { Component, ElementRef, NgZone, OnDestroy, OnInit, ViewChild } from '@angular/core';

import { ChatMessage } from '@udonarium/chat-message';
import { ChatTab } from '@udonarium/chat-tab';
import { ImageFile } from '@udonarium/core/file-storage/image-file';
import { ImageStorage } from '@udonarium/core/file-storage/image-storage';
import { ServerMediaStorage } from '@udonarium/core/file-storage/server-media-storage';
import { ObjectStore } from '@udonarium/core/synchronize-object/object-store';
import { EventSystem, Network } from '@udonarium/core/system';
import { GameCharacter } from '@udonarium/game-character';
import { DiceBot } from '@udonarium/dice-bot';
import { ChatMessageService } from 'service/chat-message.service';
import { GmModeService } from 'service/gm-mode.service';

const BUBBLE_MS = 8000;
const SPEAKING_MS = 2500;
const MAX_ACTORS = 6;
const PORTRAIT_FADE_MS = 160;

interface VnActor {
  characterId: string;
  name: string;
  tachieIndex: number;
  imageIdentifier: string;
  previousImageIdentifier: string;
  isPortraitFading: boolean;
  portraitFadeTimer: any;
  text: string;
  enterKey: number;
  speakingUntil: number;
  bubbleUntil: number;
  lastSpokeAt: number;
  isEntering: boolean;
  // per-actor typewriter state
  displayedText: string;
  typewriterIndex: number;
  typewriterTimer: any;
  lastBubbleUntil: number;
  bubbleKey: number;
}

@Component({
  selector: 'vn-stage',
  templateUrl: './vn-stage.component.html',
  styleUrls: ['./vn-stage.component.css']
})
export class VnStageComponent implements OnInit, OnDestroy {
  @ViewChild('logScroll', { static: false }) logScrollEl: ElementRef;
  @ViewChild('paletteScroll', { static: false }) paletteScrollEl: ElementRef;

  actors: VnActor[] = [];
  selectedCharacterId: string = '';
  selectedTachieIndex: number = 0;
  inputText: string = '';
  verticalOffset: number = this.loadNumber('udonarium.vnStage.verticalOffset.v1', 0);
  now: number = Date.now();
  isHotbarVisible: boolean = false;
  isAutoFit: boolean = true;
  affectPiece: boolean = false;
  sendPortrait: boolean = true;

  // Chat log panel
  chatLogExpanded: boolean = false;
  chatLogPinned: boolean = false;
  selectedTabIdentifier: string = '';
  selectedDiceBot: string = 'DiceBot';
  private chatLogFadeTimer: any = null;
  chatLogVisible: boolean = true;

  // Typewriter effect — per actor (stored in VnActor)

  readonly diceTypes = ['d4', 'd6', 'd8', 'd10', 'd12', 'd20', 'd100'];
  private loadingImages: Set<string> = new Set();
  private clockTimer: NodeJS.Timer = null;
  private enterCounter = 0;
  private diceBuffer: string = '';
  private diceCounters: Map<string, number> = new Map();

  // Cache for characters getter to avoid repeated ObjectStore scans during sync
  private _charactersCache: GameCharacter[] | null = null;
  private _charactersCacheTimer: any = null;
  private syncGraceTimer: any = null;

  constructor(
    public chatMessageService: ChatMessageService,
    private ngZone: NgZone,
    private gmModeService: GmModeService
  ) { }

  ngOnInit() {
    this.selectedCharacterId = this.loadSelectedCharacterId();
    this.ensureSelectedCharacter();
    // initialize imageId for selected character
    const initChar = ObjectStore.instance.get<GameCharacter>(this.selectedCharacterId);
    if (initChar instanceof GameCharacter && initChar.imageDataElement) {
      const children = initChar.imageDataElement.children || [];
      if (children.length > 0) this.selectedImageId = String((children[0] as any)?.value ?? '');
    }

    try { this.isHotbarVisible = localStorage.getItem('udonarium.macroHotbar.visible.v1') !== '0'; } catch (_) { this.isHotbarVisible = true; }
    try { this.isAutoFit = localStorage.getItem('udonarium.vnStage.autoFit.v1') === '1'; } catch (_) { }
    try { this.affectPiece = localStorage.getItem('udonarium.vnStage.affectPiece.v1') === '1'; } catch (_) { }
    try { this.sendPortrait = localStorage.getItem('udonarium.vnStage.sendPortrait.v1') !== 'false'; } catch (_) { }

    // Defer event registration and timer to avoid interfering with initial sync
    // During SYNCHRONIZE_GAME_OBJECT, vn-stage must be completely inert
    this.syncGraceTimer = setTimeout(() => {
      this.registerEventHandlers();
      this.clockTimer = setInterval(() => {
        this.ngZone.run(() => { this.now = Date.now(); });
      }, 100);
    }, 1000);
  }

  private registerEventHandlers() {
    EventSystem.register(this)
      .on('VN_STAGE_ADD', event => {
        if (event.isSendFromSelf) return;
        const d = event.data;
        if (!d || !d.characterId) return;
        this.ngZone.run(() => this.upsertActor(d.characterId, d.name, d.tachieIndex ?? 0, d.imageIdentifier || '', '', false, false));
      })
      .on('VN_STAGE_REMOVE', event => {
        if (event.isSendFromSelf) return;
        this.ngZone.run(() => this.removeActorInternal(event.data?.characterId));
      })
      .on('VN_STAGE_CLEAR', event => {
        if (event.isSendFromSelf) return;
        this.ngZone.run(() => { this.actors = []; });
      })
      .on('VN_STAGE_FULL', event => {
        if (event.isSendFromSelf) return;
        const list: any[] = event.data?.actors;
        if (!Array.isArray(list)) return;
        this.ngZone.run(() => {
          for (const a of list) {
            if (a?.characterId) this.upsertActor(a.characterId, a.name, a.tachieIndex ?? 0, a.imageIdentifier, '', false, false);
          }
        });
      })
      .on('MESSAGE_ADDED', event => {
        const message = ObjectStore.instance.get<ChatMessage>(event.data.messageIdentifier);
        if (!message) return;
        if (event.isSendFromSelf) {
          if (this.chatLogExpanded) {
            this.scrollLogToBottom();
            this.refreshChatLogFade();
          }
          return;
        }
        if (this.isDisplayableMessage(message)) {
          this.ngZone.run(() => this.applyChatMessage(message));
        }
        if (this.chatLogExpanded) {
          this.scrollLogToBottom();
          this.refreshChatLogFade();
        }
      })
      .on('CONNECT_PEER', event => {
        if (!event.isSendFromSelf) return;
        const peerId: string = event.data?.peerId;
        if (!peerId) return;
        const payload = this.actors.map(a => ({
          characterId: a.characterId, name: a.name, tachieIndex: a.tachieIndex, imageIdentifier: a.imageIdentifier
        }));
        EventSystem.call('VN_STAGE_FULL', { actors: payload }, peerId);
      })
      .on('MACRO_HOTBAR_VISIBILITY_CHANGED', event => {
        this.ngZone.run(() => { this.isHotbarVisible = !!event.data?.visible; });
      })
      .on('VN_STAGE_VISIBILITY_CHANGED', event => {
        if (event.data?.visible) {
          this.restoreActorsFromTable();
        }
      })
      .on('VN_STAGE_PIECE_SCALE_CHANGED', event => { })
      .on('VN_STAGE_AUTOFIT_CHANGED', event => {
        this.ngZone.run(() => { this.isAutoFit = event.data?.autoFit ?? true; });
      })
      .on('VN_STAGE_SELECT_CHARACTER', event => {
        const characterId = event.data?.characterId;
        if (!characterId) return;
        this.ngZone.run(() => this.selectCharacterFromBoard(characterId));
      })
      .on('VN_STAGE_REQUEST', event => {
        // Another peer is asking for our VN actors — send them VN_STAGE_FULL
        const requesterPeerId = event.data?.requesterPeerId;
        if (!requesterPeerId) return;
        const payload = this.actors.map(a => ({
          characterId: a.characterId, name: a.name, tachieIndex: a.tachieIndex, imageIdentifier: a.imageIdentifier
        }));
        EventSystem.call('VN_STAGE_FULL', { actors: payload }, requesterPeerId);
      })
      // Fallback: detect ChatMessage syncs from other peers (MESSAGE_ADDED only fires locally)
      .on('UPDATE_GAME_OBJECT', 1, event => {
        if (event.isSendFromSelf) return;
        const obj = ObjectStore.instance.get<ChatMessage>(event.data?.identifier);
        if (!(obj instanceof ChatMessage)) return;
        if (!obj.text || obj.isSystem || obj.isSecret || obj.isDicebot) return;
        const charId = obj.sendFrom || obj.from;
        if (!charId) return;
        const actor = this.findActor(charId);
        if (!actor) return;
        if (actor.text === obj.text && Date.now() - actor.lastSpokeAt < 3000) return;
        this.ngZone.run(() => this.applyChatMessage(obj));
      });
    console.log('[VN] Event handlers registered after sync grace period');

    // Request VN_STAGE_FULL from all existing peers (handles late VN activation)
    const peers = Network.peerContexts.filter(p => p.peerId !== Network.peerContext?.peerId);
    for (const peer of peers) {
      EventSystem.call('VN_STAGE_REQUEST', { requesterPeerId: Network.peerContext?.peerId }, peer.peerId);
    }
  }

  /** Scan table characters and restore actors for those with tachie images set */
  private restoreActorsFromTable() {
    const chars = ObjectStore.instance.getObjects<GameCharacter>(GameCharacter);
    for (const c of chars) {
      if (!c || c.nonTalkFlag) continue;
      if (!c.imageDataElement) continue;
      const children = c.imageDataElement.children || [];
      if (children.length === 0) continue;
      const imageIdentifier = String(children[c.selectedTachieNum]?.value || '');
      if (!imageIdentifier) continue;
      // Only add if not already an actor
      if (this.findActor(c.identifier)) continue;
      this.upsertActor(c.identifier, c.name, c.selectedTachieNum, imageIdentifier, '', false, false);
    }
  }

  ngOnDestroy() {
    EventSystem.unregister(this);
    if (this.syncGraceTimer) clearTimeout(this.syncGraceTimer);
    if (this.clockTimer) clearInterval(this.clockTimer);
    if (this.chatLogFadeTimer) clearTimeout(this.chatLogFadeTimer);
    if (this.paletteFadeTimer) clearTimeout(this.paletteFadeTimer);
    if (this.indexFadeTimer) clearTimeout(this.indexFadeTimer);
    if (this._charactersCacheTimer) clearTimeout(this._charactersCacheTimer);
    for (const a of this.actors) {
      if (a.typewriterTimer) { clearTimeout(a.typewriterTimer); clearInterval(a.typewriterTimer); }
    }
  }

  /* ═══════════ template helpers ═══════════ */

  get characters(): GameCharacter[] {
    if (this._charactersCache) return this._charactersCache;
    this._charactersCache = ObjectStore.instance.getObjects<GameCharacter>(GameCharacter)
      .filter(c => this.canUseCharacter(c))
      .sort((a, b) => a.name.localeCompare(b.name));
    // Invalidate cache after 2 seconds
    if (this._charactersCacheTimer) clearTimeout(this._charactersCacheTimer);
    this._charactersCacheTimer = setTimeout(() => { this._charactersCache = null; }, 2000);
    return this._charactersCache;
  }

  private canUseCharacter(c: GameCharacter): boolean {
    if (!c || c.nonTalkFlag) return false;
    const isGm = this.gmModeService.isGm;
    if (!isGm && c.visibility === 'gmOnly') return false;
    if (!isGm && !!c.secretDetails) return false;
    return true;
  }

  get chatTabs(): ChatTab[] { return this.chatMessageService.chatTabs; }

  get selectedTab(): ChatTab {
    if (!this.selectedTabIdentifier && this.chatTabs.length > 0) return this.chatTabs[0];
    return this.chatTabs.find(t => t.identifier === this.selectedTabIdentifier) || this.chatTabs[0];
  }

  get chatLogMessages(): ChatMessage[] {
    const tab = this.selectedTab;
    if (!tab) return [];
    return (tab.chatMessages || []).filter(m => m && m.isDisplayable).slice(-80);
  }

  get diceBotInfos() { return DiceBot.diceBotInfos || []; }

  isSectionHeader(line: string): boolean {
    return !!(line && (line.match(/^\/\/---/) || line.match(/^◆/)));
  }

  sectionTitle(line: string): string {
    return line.replace(/^\/\/---+/, '').replace(/-+$/, '').replace(/^◆/, '');
  }

  get selectedPaletteLines(): string[] {
    const character = ObjectStore.instance.get<GameCharacter>(this.selectedCharacterId);
    if (!(character instanceof GameCharacter)) return [];
    const palette = character.chatPalette;
    if (!palette) return [];
    const lines = palette.getPalette();
    return lines.filter(l => l && !l.match(/^\/\/---/) && !l.match(/^◆/));
  }

  get selectedPaletteIndex(): { name: string; line: number }[] {
    const character = ObjectStore.instance.get<GameCharacter>(this.selectedCharacterId);
    if (!(character instanceof GameCharacter)) return [];
    const palette = character.chatPalette;
    if (!palette) return [];
    return palette.paletteIndex || [];
  }

  get selectedAllPaletteLines(): string[] {
    const character = ObjectStore.instance.get<GameCharacter>(this.selectedCharacterId);
    if (!(character instanceof GameCharacter)) return [];
    const palette = character.chatPalette;
    if (!palette) return [];
    return palette.getPalette();
  }

  get visiblePaletteLines(): string[] {
    const lines = this.selectedAllPaletteLines;
    const q = this.paletteSearchText.trim().toLowerCase();
    if (!q) return lines;
    return lines.filter(line => line && line.toLowerCase().includes(q));
  }

  paletteExpanded: boolean = false;
  indexExpanded: boolean = false;
  paletteVisible: boolean = true;
  indexVisible: boolean = true;
  paletteSearchText: string = '';
  private paletteFadeTimer: any = null;
  private indexFadeTimer: any = null;
  scrollToIndex: number = -1;

  get hasInputText(): boolean { return this.inputText.trim().length > 0; }

  get debugInfo(): string {
    const actor = this.findActor(this.selectedCharacterId);
    return `actors=${this.actors.length} char=${this.selectedCharacterId || '-'} tachie=${this.selectedTachieIndex} img=${actor?.imageIdentifier || '-'} url=${actor && this.getImage(actor.imageIdentifier).url ? 'yes' : 'no'} slots=${this.tachieSlots.length}`;
  }

  /** Dynamic tachie slots for selected character */
  get tachieSlots(): { index: number; label: string; imageId: string }[] {
    const character = ObjectStore.instance.get<GameCharacter>(this.selectedCharacterId);
    if (!(character instanceof GameCharacter) || !character.imageDataElement) return [];
    const children = character.imageDataElement.children || [];
    if (children.length < 1) return [];
    const slots: { index: number; label: string; imageId: string }[] = [];
    for (let i = 0; i < children.length; i++) {
      const child: any = children[i];
      const label = this.tachieLabel(child);
      const id = String(child?.value ?? child?.getAttribute?.('value') ?? '');
      if (id) {
        slots.push({ index: i, label: label ? `${i} ${label}` : `${i}`, imageId: id });
      }
    }
    return slots;
  }

  actorImage(actor: VnActor): ImageFile {
    if (!actor?.imageIdentifier) return ImageFile.Empty;
    return this.imageByIdentifier(actor.imageIdentifier);
  }

  actorPreviousImage(actor: VnActor): ImageFile {
    if (!actor?.previousImageIdentifier) return ImageFile.Empty;
    return this.imageByIdentifier(actor.previousImageIdentifier);
  }

  imageByIdentifier(identifier: string): ImageFile {
    if (!identifier) return ImageFile.Empty;
    const img = this.getImage(identifier);
    if (!img.url) this.ensureImageLoaded(identifier);
    return img;
  }

  actorHasPortrait(actor: VnActor): boolean {
    const img = this.actorImage(actor);
    return img && !img.isEmpty && !!img.url;
  }

  actorLeft(index: number): string {
    const n = Math.max(1, this.actors.length);
    if (n === 1) return '38%';
    const start = n <= 3 ? 24 : 16;
    const end = n <= 3 ? 76 : 84;
    return `${start + ((end - start) * index / (n - 1))}%`;
  }

  actorScale(index: number): number {
    const n = this.actors.length;
    return n <= 2 ? 1 : n === 3 ? 0.9 : 0.8;
  }

  actorZIndex(index: number, actor: VnActor): number {
    return this.showBubble(actor) || this.isSpeaking(actor) ? 1000 + index : 100 + index;
  }

  bubbleSide(index: number): string {
    const n = this.actors.length;
    if (n <= 1) return 'right';
    return index <= (n - 1) / 2 ? 'right' : 'left';
  }

  isSpeaking(actor: VnActor): boolean { return actor && this.now < actor.speakingUntil; }
  showBubble(actor: VnActor): boolean { return actor && actor.text && this.now < actor.bubbleUntil; }

  getTypewriterText(characterId: string): string {
    const actor = this.findActor(characterId);
    if (!actor) return '';
    return actor.displayedText || '';
  }

  private startActorTypewriter(actor: VnActor, text: string) {
    if (actor.typewriterTimer) {
      clearTimeout(actor.typewriterTimer);
      clearInterval(actor.typewriterTimer);
    }
    // Show bubble first with empty text, then start typewriter after a short delay
    actor.displayedText = '';
    actor.typewriterIndex = 0;
    actor.typewriterTimer = setTimeout(() => {
      let idx = 0;
      actor.typewriterTimer = setInterval(() => {
        this.ngZone.run(() => {
          idx++;
          actor.typewriterIndex = idx;
          actor.displayedText = text.substring(0, idx);
          if (idx >= text.length) {
            clearInterval(actor.typewriterTimer as any);
            actor.typewriterTimer = null;
          }
        });
      }, 40);
    }, 300) as any;
  }
  trackByCharacterId(index: number, actor: VnActor): string { return actor.characterId; }

  // Drag & drop reordering
  private dragIndex: number = -1;
  private dropIndex: number = -1;

  onDragStart(index: number, event: DragEvent) {
    this.dragIndex = index;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', String(index));
  }

  onDragOver(index: number, event: DragEvent) {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    this.dropIndex = index;
  }

  onDrop(index: number, event: DragEvent) {
    event.preventDefault();
    if (this.dragIndex < 0 || this.dragIndex === index) { this.dragIndex = -1; this.dropIndex = -1; return; }
    const item = this.actors.splice(this.dragIndex, 1)[0];
    this.actors.splice(index, 0, item);
    this.dragIndex = -1;
    this.dropIndex = -1;
  }

  onDragEnd() {
    this.dragIndex = -1;
    this.dropIndex = -1;
  }

  /* ═══════════ user actions ═══════════ */

  selectTachie(index: number) {
    this.selectedTachieIndex = index;
    const character = ObjectStore.instance.get<GameCharacter>(this.selectedCharacterId);
    if (character instanceof GameCharacter && character.imageDataElement) {
      const children = character.imageDataElement.children || [];
      if (index >= 0 && index < children.length) {
        const child: any = children[index];
        this.selectedImageId = String(child?.value ?? child?.getAttribute?.('value') ?? '');
        if (this.selectedImageId) this.ensureImageLoaded(this.selectedImageId);
      }
    }
    // update stage actor if already on stage
    const actor = this.findActor(this.selectedCharacterId);
    if (actor) {
      actor.tachieIndex = this.selectedTachieIndex;
      if (this.selectedImageId) this.setActorImage(actor, this.selectedImageId);
      if (this.affectPiece) this.applyTachieToPiece(character, this.selectedTachieIndex);
      EventSystem.call('VN_STAGE_ADD', {
        characterId: this.selectedCharacterId, name: actor.name, tachieIndex: this.selectedTachieIndex, imageIdentifier: this.selectedImageId
      });
    }
  }
  private selectedImageId: string = '';

  onCharacterChange() {
    try { localStorage.setItem('udonarium.vnStage.selectedCharacterId.v1', this.selectedCharacterId || ''); } catch (_) { }
    this.selectedTachieIndex = 0;
    this.selectedImageId = '';
    const slots = this.tachieSlots;
    if (slots.length > 0) this.selectedImageId = slots[0].imageId;

    // Auto-select dicebot from character's palette
    const character = ObjectStore.instance.get<GameCharacter>(this.selectedCharacterId);
    if (character instanceof GameCharacter && character.chatPalette) {
      const db = character.chatPalette.dicebot;
      if (db) {
        this.selectedDiceBot = db;
      }
    }
  }

  selectCharacterFromBoard(characterId: string) {
    const character = ObjectStore.instance.get<GameCharacter>(characterId);
    if (!(character instanceof GameCharacter) || !this.canUseCharacter(character)) return;
    this.selectedCharacterId = characterId;
    this.onCharacterChange();
  }

  toggleAffectPiece() {
    this.affectPiece = !this.affectPiece;
    try { localStorage.setItem('udonarium.vnStage.affectPiece.v1', this.affectPiece ? '1' : '0'); } catch (_) { }
  }

  toggleSendPortrait() {
    this.sendPortrait = !this.sendPortrait;
    try { localStorage.setItem('udonarium.vnStage.sendPortrait.v1', this.sendPortrait ? '1' : 'false'); } catch (_) { }
  }

  sendVnChat() {
    const text = this.inputText.trim();
    if (!text) return;
    this.ensureSelectedCharacter();
    const chatTab = this.selectedTab || this.chatTabs[0];
    if (!chatTab || !this.selectedCharacterId) return;

    const character = ObjectStore.instance.get<GameCharacter>(this.selectedCharacterId);
    const onStage = !!this.findActor(this.selectedCharacterId);
    const shouldSendPortrait = this.sendPortrait && onStage;
    const tachieNum = shouldSendPortrait && character instanceof GameCharacter
      ? this.selectedTachieIndex : null;

    // Evaluate palette variables like hotbar does
    let evaluatedText = text;
    let gameType = this.selectedDiceBot || 'DiceBot';
    let messageColor: string = null;
    if (character instanceof GameCharacter) {
      const palette = character.chatPalette;
      if (palette) {
        evaluatedText = palette.evaluate(text, character.rootDataElement);
        if (!this.selectedDiceBot || this.selectedDiceBot === 'DiceBot') {
          gameType = palette.dicebot || 'DiceBot';
        }
      }
      if (character.chatColorCode && character.chatColorCode.length > 0) {
        messageColor = character.chatColorCode[0];
      }
    }

    // Update actor directly
    const actor = this.findActor(this.selectedCharacterId);
    if (actor) {
      actor.text = evaluatedText;
      actor.speakingUntil = Date.now() + SPEAKING_MS;
      actor.bubbleUntil = Date.now() + BUBBLE_MS;
      actor.bubbleKey++;
      this.now = Date.now();
      this.startActorTypewriter(actor, evaluatedText);
    }

    if (gameType && gameType !== 'DiceBot') {
      DiceBot.loadGameSystemAsync(gameType).then(gs => {
        this.chatMessageService.sendMessage(chatTab, evaluatedText, gs, this.selectedCharacterId, null, tachieNum, messageColor);
      });
    } else {
      this.chatMessageService.sendMessage(chatTab, evaluatedText, null, this.selectedCharacterId, null, tachieNum, messageColor);
    }
    this.inputText = '';
    this.diceCounters.clear();
    this.diceBuffer = '';
  }

  removeActor(characterId: string) {
    this.removeActorInternal(characterId);
    EventSystem.call('VN_STAGE_REMOVE', { characterId });
  }

  clearStage() {
    this.actors = [];
    EventSystem.call('VN_STAGE_CLEAR', {});
  }

  selectActor(characterId: string) {
    this.selectedCharacterId = characterId;
    try { localStorage.setItem('udonarium.vnStage.selectedCharacterId.v1', characterId); } catch (_) { }
    const actor = this.findActor(characterId);
    if (actor) {
      this.selectedTachieIndex = actor.tachieIndex;
      this.selectedImageId = actor.imageIdentifier;
    }
    // Auto-select dicebot from character's palette
    const character = ObjectStore.instance.get<GameCharacter>(characterId);
    if (character instanceof GameCharacter && character.chatPalette) {
      const db = character.chatPalette.dicebot;
      if (db) {
        this.selectedDiceBot = db;
      }
    }
  }

  nudgeUp() { this.setVerticalOffset(this.verticalOffset - 16); }
  nudgeDown() { this.setVerticalOffset(this.verticalOffset + 16); }
  resetPosition() { this.setVerticalOffset(0); }

  enterStage() {
    if (!this.selectedCharacterId) return;
    const character = ObjectStore.instance.get<GameCharacter>(this.selectedCharacterId);
    if (!(character instanceof GameCharacter)) return;
    const name = character.name || '';
    const imageIdentifier = this.selectedImageId || this.findImageIdentifierByIndex(character, this.selectedTachieIndex);

    this.upsertActor(character.identifier, name, this.selectedTachieIndex, imageIdentifier, '', false, true);

    if (this.affectPiece) this.applyTachieToPiece(character, this.selectedTachieIndex);

    EventSystem.call('VN_STAGE_ADD', {
      characterId: character.identifier, name, tachieIndex: this.selectedTachieIndex, imageIdentifier
    });
  }

  addDice(die: string) {
    const count = (this.diceCounters.get(die) || 0) + 1;
    this.diceCounters.set(die, count);
    this.rebuildDiceBuffer();
  }

  clearDice() {
    this.diceCounters.clear();
    this.diceBuffer = '';
    this.syncInputWithDice();
  }

  toggleChatLog() {
    this.chatLogExpanded = !this.chatLogExpanded;
    if (this.chatLogExpanded) {
      this.refreshChatLogFade();
      this.scrollLogToBottom();
    }
  }

  toggleChatLogPin() {
    this.chatLogPinned = !this.chatLogPinned;
  }

  selectTab(tabId: string) {
    this.selectedTabIdentifier = tabId;
  }

  selectDiceBot(botId: string) {
    this.selectedDiceBot = botId;
  }

  togglePalette() {
    this.paletteExpanded = !this.paletteExpanded;
    if (this.paletteExpanded) {
      this.paletteVisible = true;
      this.refreshPaletteFade();
      // scroll to top on open
      setTimeout(() => {
        try {
          const el = this.paletteScrollEl?.nativeElement;
          if (el) el.scrollTop = 0;
        } catch (_) { }
      }, 50);
    }
  }

  onPaletteScroll(event: Event) {
    const el = event.target as HTMLElement;
    const atTop = el.scrollTop <= 0;
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
    // If not at top or bottom, user is scrolling — keep visible
    if (!atTop || !atBottom) {
      this.paletteVisible = true;
      this.refreshPaletteFade();
    }
  }

  toggleIndex() {
    this.indexExpanded = !this.indexExpanded;
    if (this.indexExpanded) {
      this.refreshIndexFade();
    }
  }

  jumpToIndex(idx: { name: string; line: number }) {
    this.paletteSearchText = '';
    this.scrollToIndex = idx.line;
    this.refreshPaletteFade();
    this.refreshIndexFade();
    setTimeout(() => {
      try {
        const el = document.querySelector('.vn-palette-scroll');
        if (el) {
          const items = el.querySelectorAll('.vn-palette-line');
          if (items[idx.line]) items[idx.line].scrollIntoView({ block: 'center' });
        }
      } catch (_) { }
    }, 100);
  }

  sendPaletteLine(line: string) {
    const character = ObjectStore.instance.get<GameCharacter>(this.selectedCharacterId);
    if (!(character instanceof GameCharacter)) return;
    const palette = character.chatPalette;
    if (!palette) return;
    const evaluated = palette.evaluate(line, character.rootDataElement, character);
    if (!evaluated) return;
    const chatTab = this.selectedTab || this.chatTabs[0];
    if (!chatTab) return;

    const actor = this.findActor(this.selectedCharacterId);
    const onStage = !!actor;
    const shouldSendPortrait = this.sendPortrait && onStage;
    const tachieNum = shouldSendPortrait ? this.selectedTachieIndex : null;
    const messageColor = character.chatColorCode?.length ? character.chatColorCode[0] : null;
    const gameType = palette.dicebot || this.selectedDiceBot || 'DiceBot';

    if (actor) {
      actor.text = evaluated;
      actor.lastSpokeAt = Date.now();
      actor.speakingUntil = Date.now() + SPEAKING_MS;
      actor.bubbleUntil = Date.now() + BUBBLE_MS;
      actor.bubbleKey++;
      this.now = Date.now();
      this.startActorTypewriter(actor, evaluated);
    }

    if (gameType && gameType !== 'DiceBot') {
      DiceBot.loadGameSystemAsync(gameType).then(gs => {
        this.chatMessageService.sendMessage(chatTab, evaluated, gs, this.selectedCharacterId, null, tachieNum, messageColor);
      });
    } else {
      this.chatMessageService.sendMessage(chatTab, evaluated, null, this.selectedCharacterId, null, tachieNum, messageColor);
    }
    this.refreshChatLogFade();
    this.refreshPaletteFade();
    this.refreshIndexFade();
  }

  get chatLogAutoHide(): boolean {
    return !this.chatLogPinned && !this.chatLogVisible;
  }

  onInputChange() {
    const userText = this.inputText.replace(/^\d+d\d+(?:\+\d+d\d+)*\s*/, '');
    if (!this.diceBuffer && !userText) return;
    if (userText !== this.inputText.replace(/^\d+d\d+(?:\+\d+d\d+)*\s*/, '')) {
      this.diceCounters.clear();
      this.diceBuffer = '';
    }
    // removed previewOrBroadcast — don't auto-add to stage
  }

  onInputKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.sendVnChat();
    }
  }

  /* ═══════════ core logic ═══════════ */

  previewOrBroadcast() {
    const character = ObjectStore.instance.get<GameCharacter>(this.selectedCharacterId);
    if (!(character instanceof GameCharacter)) return;

    // use cached imageId, fallback to lookup
    let imageIdentifier = this.selectedImageId;
    if (!imageIdentifier) {
      imageIdentifier = this.findImageIdentifierByIndex(character, this.selectedTachieIndex);
    }
    const name = character.name || '';

    this.upsertActor(character.identifier, name, this.selectedTachieIndex, imageIdentifier, '', false, true);

    if (this.affectPiece) {
      this.applyTachieToPiece(character, this.selectedTachieIndex);
    }

    EventSystem.call('VN_STAGE_ADD', {
      characterId: character.identifier, name, tachieIndex: this.selectedTachieIndex, imageIdentifier
    });
  }

  private applyTachieToPiece(character: GameCharacter, tachieIndex: number) {
    character.selectedTachieNum = tachieIndex;
    // also update ICON currentValue so the piece portrait actually changes
    const iconNum = character.detailDataElement?.getFirstElementByName('ICON');
    if (iconNum && iconNum.isNumberResource) {
      iconNum.currentValue = tachieIndex;
    }
  }

  private applyChatMessage(message: ChatMessage) {
    const characterId = message.sendFrom || message.from;
    if (!characterId) return;
    // Only update actors already on stage — don't auto-add
    const actor = this.findActor(characterId);
    if (!actor) return;
    const character = ObjectStore.instance.get<GameCharacter>(characterId);
    const name = message.name || (character instanceof GameCharacter ? character.name : '');
    const imageIdentifier = message.imageIdentifier || '';
    const tachieIndex = imageIdentifier && character instanceof GameCharacter
      ? this.findTachieIndexByIdentifier(character, imageIdentifier) : actor.tachieIndex;
    actor.name = name || actor.name;
    actor.text = message.text || '';
    actor.lastSpokeAt = Date.now();
    actor.speakingUntil = Date.now() + SPEAKING_MS;
    actor.bubbleUntil = Date.now() + BUBBLE_MS;
    actor.bubbleKey++;
    this.now = Date.now(); // immediate update to prevent race
    this.startActorTypewriter(actor, actor.text);
    if (imageIdentifier) this.setActorImage(actor, imageIdentifier);
    actor.tachieIndex = tachieIndex;
    if (actor.imageIdentifier) this.ensureImageLoaded(actor.imageIdentifier);
    // Refresh chat log auto-hide timer
    this.refreshChatLogFade();
    this.scrollLogToBottom();
  }

  private upsertActor(
    characterId: string, name: string, tachieIndex: number, imageIdentifier: string,
    text: string, speaking: boolean, broadcast: boolean
  ) {
    if (!characterId) return;
    const now = Date.now();
    let actor = this.findActor(characterId);
    const isNew = !actor;

    if (!actor) {
      actor = {
        characterId, name, tachieIndex, imageIdentifier, previousImageIdentifier: '', isPortraitFading: false, portraitFadeTimer: null, text: '',
        enterKey: ++this.enterCounter,
        speakingUntil: 0, bubbleUntil: 0, lastSpokeAt: now,
        isEntering: true,
        displayedText: '', typewriterIndex: 0, typewriterTimer: null, lastBubbleUntil: 0, bubbleKey: 0,
      };
      this.actors.push(actor);
      setTimeout(() => this.ngZone.run(() => { actor.isEntering = false; }), 400);
    }

    actor.name = name || actor.name;
    actor.tachieIndex = tachieIndex;
    if (imageIdentifier) this.setActorImage(actor, imageIdentifier, isNew);
    if (text) actor.text = text;
    actor.lastSpokeAt = now;

    if (speaking && text) {
      actor.speakingUntil = now + SPEAKING_MS;
      actor.bubbleUntil = now + BUBBLE_MS;
      actor.bubbleKey++;
      this.startActorTypewriter(actor, text);
    }
    if (isNew) actor.enterKey = ++this.enterCounter;

    if (actor.imageIdentifier) this.ensureImageLoaded(actor.imageIdentifier);

    // Don't reorder — keep manual order from drag-and-drop
    if (isNew) {
      this.actors = this.actors.slice(-MAX_ACTORS);
    }
  }

  private removeActorInternal(characterId: string) {
    const actor = this.findActor(characterId);
    if (actor?.portraitFadeTimer) clearTimeout(actor.portraitFadeTimer);
    this.actors = this.actors.filter(a => a.characterId !== characterId);
  }

  private setActorImage(actor: VnActor, imageIdentifier: string, immediate: boolean = false) {
    if (!actor || !imageIdentifier || actor.imageIdentifier === imageIdentifier) return;
    const previous = actor.imageIdentifier;
    if (actor.portraitFadeTimer) {
      clearTimeout(actor.portraitFadeTimer);
      actor.portraitFadeTimer = null;
    }

    if (!immediate && previous) {
      actor.previousImageIdentifier = previous;
      actor.isPortraitFading = true;
    } else {
      actor.previousImageIdentifier = '';
      actor.isPortraitFading = false;
    }

    actor.imageIdentifier = imageIdentifier;
    this.ensureImageLoaded(imageIdentifier);
    if (actor.previousImageIdentifier) this.ensureImageLoaded(actor.previousImageIdentifier);

    if (actor.isPortraitFading) {
      actor.portraitFadeTimer = setTimeout(() => this.ngZone.run(() => {
        actor.previousImageIdentifier = '';
        actor.isPortraitFading = false;
        actor.portraitFadeTimer = null;
      }), PORTRAIT_FADE_MS);
    }
  }

  private findActor(characterId: string): VnActor {
    return this.actors.find(a => a.characterId === characterId);
  }

  /* ═══════════ image helpers ═══════════ */

  private getImage(identifier: string): ImageFile {
    if (!identifier) return ImageFile.Empty;
    return ImageStorage.instance.get(identifier) || ImageFile.Empty;
  }

  private ensureImageLoaded(identifier: string) {
    if (!identifier || this.loadingImages.has(identifier)) return;
    const cached = ImageStorage.instance.get(identifier);
    if (cached && cached.url) return;
    this.loadingImages.add(identifier);
    ServerMediaStorage.fetchImage(identifier)
      .then(image => {
        if (image) {
          ImageStorage.instance.add(image);
          this.ngZone.run(() => { this.now = Date.now(); });
        }
      })
      .catch(err => console.warn('VN image fetch fail', identifier, err))
      .finally(() => this.loadingImages.delete(identifier));
  }

  /* ═══════════ tachie helpers ═══════════ */

  private findImageIdentifierByIndex(character: GameCharacter, index: number): string {
    if (!character?.imageDataElement) return '';
    const children = character.imageDataElement.children || [];
    if (children.length < 1) return '';
    const i = Math.max(0, Math.min(index, children.length - 1));
    const child: any = children[i];
    const id = String(child?.value || '');
    if (id) this.ensureImageLoaded(id);
    return id;
  }

  private findTachieIndexByIdentifier(character: GameCharacter, imageIdentifier: string): number {
    if (!character?.imageDataElement || !imageIdentifier) return 0;
    const children = character.imageDataElement.children || [];
    for (let i = 0; i < children.length; i++) {
      if (String((children[i] as any)?.value || '') === imageIdentifier) return i;
    }
    return 0;
  }

  private tachieLabel(child: any): string {
    if (!child) return '';
    return String(child.currentValue || child.getAttribute?.('currentValue') || '');
  }

  private rebuildDiceBuffer() {
    const parts: string[] = [];
    for (const d of this.diceTypes) {
      const c = this.diceCounters.get(d);
      if (c) parts.push(`${c}${d}`);
    }
    this.diceBuffer = parts.join('+');
    this.syncInputWithDice();
  }

  private syncInputWithDice() {
    const prefix = this.diceBuffer ? this.diceBuffer + ' ' : '';
    const userText = this.inputText.replace(/^\d+d\d+(?:\+\d+d\d+)*\s*/, '');
    this.inputText = prefix + userText;
  }

  /* ═══════════ misc ═══════════ */

  private isDisplayableMessage(m: ChatMessage): boolean {
    return !!(m && m.isDisplayable && !m.isSystem && !m.isSecret && !m.isDicebot && m.text?.trim());
  }

  private ensureSelectedCharacter() {
    const chars = this.characters;
    if (this.selectedCharacterId && chars.some(c => c.identifier === this.selectedCharacterId)) return;
    this.selectedCharacterId = chars.length ? chars[0].identifier : '';
  }

  private setVerticalOffset(v: number) {
    this.verticalOffset = Math.max(-220, Math.min(160, v));
    try { localStorage.setItem('udonarium.vnStage.verticalOffset.v1', String(this.verticalOffset)); } catch (_) { }
  }

  private loadNumber(key: string, fb: number): number {
    try { const v = Number(localStorage.getItem(key)); return Number.isFinite(v) ? v : fb; } catch (_) { return fb; }
  }

  private loadSelectedCharacterId(): string {
    try { return localStorage.getItem('udonarium.vnStage.selectedCharacterId.v1') || ''; } catch (_) { return ''; }
  }

  private refreshChatLogFade() {
    this.chatLogVisible = true;
    if (this.chatLogFadeTimer) clearTimeout(this.chatLogFadeTimer);
    if (this.chatLogPinned) return;
    this.chatLogFadeTimer = setTimeout(() => {
      this.ngZone.run(() => { this.chatLogVisible = false; });
    }, 5000);
  }

  private refreshPaletteFade() {
    this.paletteVisible = true;
    // no auto-fade for palette
  }

  private refreshIndexFade() {
    this.indexVisible = true;
    // no auto-fade for index
  }

  private scrollLogToBottom() {
    setTimeout(() => {
      try {
        const el = this.logScrollEl?.nativeElement;
        if (el) el.scrollTop = el.scrollHeight;
      } catch (_) { }
    }, 50);
  }
}
