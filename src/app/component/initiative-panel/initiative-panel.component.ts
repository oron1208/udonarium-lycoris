import { Component, NgZone, OnDestroy, OnInit } from '@angular/core';
import { EventSystem } from '@udonarium/core/system';
import { ObjectStore } from '@udonarium/core/synchronize-object/object-store';
import { GameCharacter } from '@udonarium/game-character';
import { GameTable } from '@udonarium/game-table';
import { AudioStorage } from '@udonarium/core/file-storage/audio-storage';
import { AudioFile } from '@udonarium/core/file-storage/audio-file';
import { InitiativeService, CombatEntry } from 'service/initiative.service';
import { PanelService } from 'service/panel.service';
import { EffectManagerComponent } from 'component/effect-manager/effect-manager.component';
import { GmModeService } from 'service/gm-mode.service';
import { PointerDeviceService } from 'service/pointer-device.service';
import { ContextMenuService } from 'service/context-menu.service';
import { AudioLibraryService, ServerAudioTrack } from 'service/audio-library.service';
import { Jukebox } from '@udonarium/Jukebox';
import { ChatTabList } from '@udonarium/chat-tab-list';
import { ChatTab } from '@udonarium/chat-tab';

@Component({
  selector: 'initiative-panel',
  templateUrl: './initiative-panel.component.html',
  styleUrls: ['./initiative-panel.component.css']
})
export class InitiativePanelComponent implements OnInit, OnDestroy {
  selectedDice: string = 'd6';
  diceTypes: string[] = ['d3', 'd4', 'd6', 'd8', 'd10', 'd12', 'd20', 'd100'];
  diceModifier: number = 0;
  showDiceRoller: boolean = false;
  showAddList: boolean = false;

  constructor(
    private initiativeService: InitiativeService,
    private panelService: PanelService,
    private gmModeService: GmModeService,
    private ngZone: NgZone,
    private audioLibraryService: AudioLibraryService
  ) {}

  ngOnInit() {
    EventSystem.register(this)
      .on('COMBAT_STATE_CHANGED', () => {
        this.ngZone.run(() => {});
      })
      .on('UPDATE_GAME_OBJECT', event => {
        const object = ObjectStore.instance.get(event.data.identifier);
        if (object instanceof GameTable) {
          this.ngZone.run(() => {});
        }
      })
      .on('CLOSE_INITIATIVE_PANEL', event => {
        this.ngZone.run(() => { this.panelService.close(); });
      });
  }

  ngOnDestroy() {
    EventSystem.unregister(this);
    EventSystem.trigger('INITIATIVE_PANEL_CLOSED', {});
  }

  get isCombatActive(): boolean {
    return this.initiativeService.isCombatActive;
  }

  get currentRound(): number {
    return this.initiativeService.currentRound;
  }

  get currentTurnIndex(): number {
    return this.initiativeService.currentTurnIndex;
  }

  get isGm(): boolean {
    return this.gmModeService.isGm;
  }

  get combatJoinAllTableCharacters(): boolean {
    const table = ObjectStore.instance.getObjects<GameTable>(GameTable).find(t => t.selected);
    return table?.combatJoinAllTableCharacters ?? true;
  }

  set combatJoinAllTableCharacters(value: boolean) {
    const table = ObjectStore.instance.getObjects<GameTable>(GameTable).find(t => t.selected);
    if (table) {
      table.combatJoinAllTableCharacters = value;
      table.update();
    }
  }

  get combatJoinSelectedCharacters(): boolean {
    const table = ObjectStore.instance.getObjects<GameTable>(GameTable).find(t => t.selected);
    return table?.combatJoinSelectedCharacters ?? false;
  }

  set combatJoinSelectedCharacters(value: boolean) {
    const table = ObjectStore.instance.getObjects<GameTable>(GameTable).find(t => t.selected);
    if (table) {
      table.combatJoinSelectedCharacters = value;
      table.update();
    }
  }

  get combatIncludeHiddenInventoryCharacters(): boolean {
    const table = ObjectStore.instance.getObjects<GameTable>(GameTable).find(t => t.selected);
    return table?.combatIncludeHiddenInventoryCharacters ?? true;
  }

  set combatIncludeHiddenInventoryCharacters(value: boolean) {
    const table = ObjectStore.instance.getObjects<GameTable>(GameTable).find(t => t.selected);
    if (table) {
      table.combatIncludeHiddenInventoryCharacters = value;
      table.update();
    }
  }

  get combatAutoBuffDecay(): boolean {
    const table = ObjectStore.instance.getObjects<GameTable>(GameTable).find(t => t.selected);
    return table?.combatAutoBuffDecay ?? false;
  }

  set combatAutoBuffDecay(value: boolean) {
    const table = ObjectStore.instance.getObjects<GameTable>(GameTable).find(t => t.selected);
    if (table) {
      table.combatAutoBuffDecay = value;
      table.update();
    }
  }

  get combatMessageTabId(): string {
    return this.initiativeService.combatMessageTabId;
  }
  set combatMessageTabId(value: string) {
    this.initiativeService.combatMessageTabId = value;
  }

  get chatTabs(): ChatTab[] {
    return ChatTabList.instance.chatTabs;
  }

  get isAdvancedMode(): boolean {
    const table = ObjectStore.instance.getObjects<GameTable>(GameTable).find(t => t.selected);
    return table?.roomMode === 'advanced';
  }

  get entries(): CombatEntry[] {
    return this.initiativeService.getCombatEntries();
  }

  getVisibleEntries(): CombatEntry[] {
    if (this.isGm) return this.entries;
    // PLには非公開コマを隠す
    return this.entries.filter(e => !e.isHidden);
  }

  getCurrentTurnIdentifier(): string | null {
    return this.initiativeService.getCurrentTurnIdentifier();
  }

  startCombat() {
    this.initiativeService.startCombat();
  }

  endCombat() {
    this.initiativeService.endCombat();
  }

  nextTurn() {
    this.initiativeService.nextTurn();
  }

  prevTurn() {
    this.initiativeService.prevTurn();
  }

  nextRound() {
    this.initiativeService.nextRound();
  }

  prevRound() {
    this.initiativeService.prevRound();
  }

  getCharacterIcon(identifier: string): string {
    const char = ObjectStore.instance.get<GameCharacter>(identifier);
    return char?.imageFile?.url || '';
  }

  getCharacterName(identifier: string): string {
    const char = ObjectStore.instance.get<GameCharacter>(identifier);
    return char?.name || '';
  }

  getInitiativeValue(identifier: string): number {
    const char = ObjectStore.instance.get<GameCharacter>(identifier);
    return char?.initiative || 0;
  }

  setInitiative(identifier: string, value: number) {
    const char = ObjectStore.instance.get<GameCharacter>(identifier);
    if (char) {
      char.initiative = value;
      // 戦闘中なら順序を再ソート
      if (this.isCombatActive) {
        this.resortOrder();
      }
    }
  }

  resortOrder() {
    const order = this.initiativeService.getCombatOrder();
    const chars = order.map(id => ObjectStore.instance.get<GameCharacter>(id)).filter(c => c);
    chars.sort((a, b) => (b.initiative || 0) - (a.initiative || 0));
    this.initiativeService.reorderCombat(chars.map(c => c.identifier));
  }

  toggleDiceRoller() {
    this.showDiceRoller = !this.showDiceRoller;
  }

  async rollInitiativeForAll() {
    const order = this.initiativeService.getCombatOrder();
    const visibleResults: string[] = [];
    const gmResults: string[] = [];
    for (const id of order) {
      const char = ObjectStore.instance.get<GameCharacter>(id);
      if (!char) continue;
      const formulaResult = await this.initiativeService.rollInitiativeFormulaAsync(char);
      let roll: number;
      let detail: string;
      if (formulaResult) {
        roll = formulaResult.value;
        detail = formulaResult.detail;
      } else {
        const diceSize = parseInt(this.selectedDice.replace('d', ''));
        roll = Math.floor(Math.random() * diceSize) + 1 + this.diceModifier;
        detail = `1d${diceSize}${this.diceModifier >= 0 ? '+' : ''}${this.diceModifier}`;
      }
      char.initiative = roll;
      const isGmOnly = (char.visibility || 'public') === 'gmOnly';
      const line = `${char.name}: ${roll} (${detail})`;
      if (isGmOnly) {
        gmResults.push(line);
      } else {
        visibleResults.push(line);
      }
    }
    if (this.isCombatActive) {
      this.resortOrder();
    }
    this.showDiceRoller = false;
  }

  removeEntry(identifier: string) {
    this.initiativeService.removeFromCombat(identifier);
  }

  getUnlistedCharacters(): GameCharacter[] {
    const combatOrder = this.initiativeService.getCombatOrder();
    const tableChars = ObjectStore.instance.getObjects<GameCharacter>(GameCharacter)
      .filter(c => c.location.name === 'table' && !combatOrder.includes(c.identifier));
    // イニシアチブ降順
    tableChars.sort((a, b) => (b.initiative || 0) - (a.initiative || 0));
    return tableChars;
  }

  addEntry(identifier: string) {
    this.initiativeService.addToCombat(identifier);
  }

  trackByCharId(index: number, char: GameCharacter): string {
    return char.identifier;
  }

  trackById(index: number, entry: CombatEntry): string {
    return entry.identifier;
  }

  // ===== ドラッグ&ドロップ =====
  dragIndex: number = -1;
  dragOverIndex: number = -1;

  onDragStart(e: DragEvent, index: number) {
    if (!this.isGm) { e.preventDefault(); return; }
    this.dragIndex = index;
    e.dataTransfer.effectAllowed = 'move';
  }

  onDragOver(e: DragEvent, index: number) {
 if (!this.isGm) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    this.dragOverIndex = index;
  }

  onDragLeave(e: DragEvent) {
    this.dragOverIndex = -1;
  }

  onDrop(e: DragEvent, index: number) {
    e.preventDefault();
    if (!this.isGm || this.dragIndex < 0 || this.dragIndex === index) {
      this.dragIndex = -1;
      this.dragOverIndex = -1;
      return;
    }
    // 順序を入れ替え
    const order = this.initiativeService.getCombatOrder();
    const moved = order.splice(this.dragIndex, 1)[0];
    order.splice(index, 0, moved);
    this.initiativeService.reorderCombat(order);
    this.dragIndex = -1;
    this.dragOverIndex = -1;
  }

  onDragEnd(e: DragEvent) {
    this.dragIndex = -1;
    this.dragOverIndex = -1;
  }

  get combatBgmIdentifier(): string {
    const table = ObjectStore.instance.getObjects<GameTable>(GameTable).find(t => t.selected);
    return table?.combatBgmIdentifier || '';
  }

  set combatBgmIdentifier(value: string) {
    const table = ObjectStore.instance.getObjects<GameTable>(GameTable).find(t => t.selected);
    if (table) {
      table.combatBgmIdentifier = value;
      table.update();
    }
  }

  get audioFiles(): AudioFile[] {
    return AudioStorage.instance.audios.filter(a => !a.isHidden);
  }

  get libraryTracks(): ServerAudioTrack[] {
    const jukebox = ObjectStore.instance.get<Jukebox>('Jukebox');
    if (!jukebox) return [];
    const pinnedIds = jukebox.getPinnedLibraryTrackIds();
    return pinnedIds
      .map(id => this.audioLibraryService.getTrack(id))
      .filter(t => t !== null) as ServerAudioTrack[];
  }

  getAudioName(identifier: string): string {
    if (!identifier) return 'なし';
    if (identifier.startsWith('server:')) {
      const track = this.audioLibraryService.getTrack(identifier.substring(7));
      return track?.name || '不明';
    }
    const audio = AudioStorage.instance.get(identifier);
    return audio?.name || audio?.identifier?.slice(0, 8) || '不明';
  }

  previewCombatBgm() {
    if (!this.combatBgmIdentifier) return;
    EventSystem.trigger('COMBAT_BGM_PLAY', { identifier: this.combatBgmIdentifier });
  }

  openEffectManager() {
    this.panelService.open(EffectManagerComponent, {
      title: '⚔️ バフマネージャー(β版)',
      width: 800,
      height: 600
    });
  }
}
