import { Component, NgZone, OnDestroy, OnInit } from '@angular/core';
import { EventSystem } from '@udonarium/core/system';
import { ObjectStore } from '@udonarium/core/synchronize-object/object-store';
import { GameCharacter } from '@udonarium/game-character';
import { GameTable } from '@udonarium/game-table';
import { InitiativeService, CombatEntry } from 'service/initiative.service';
import { PanelService } from 'service/panel.service';
import { GmModeService } from 'service/gm-mode.service';

@Component({
  selector: 'initiative-tracker',
  templateUrl: './initiative-tracker.component.html',
  styleUrls: ['./initiative-tracker.component.css']
})
export class InitiativeTrackerComponent implements OnInit, OnDestroy {
  isCollapsed = false;
  dragIndex: number = -1;
  dragOverIndex: number = -1;

  constructor(
    private initiativeService: InitiativeService,
    private panelService: PanelService,
    private gmModeService: GmModeService,
    private ngZone: NgZone
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
      });
  }

  ngOnDestroy() {
    EventSystem.unregister(this);
  }

  get isCombatActive(): boolean {
    return this.initiativeService.isCombatActive;
  }

  get currentRound(): number {
    return this.initiativeService.currentRound;
  }

  get currentTurnIndex(): number {
    const rawIdx = this.initiativeService.currentTurnIndex;
    if (this.isGm) return rawIdx;
    // PL側: 非公開コマをスキップした見かけ上のインデックスを計算
    const entries = this.entries;
    let visibleIdx = 0;
    for (let i = 0; i < rawIdx && i < entries.length; i++) {
      if (!entries[i].isHidden) visibleIdx++;
    }
    // 現在のターンが非公開コマの場合
    if (rawIdx < entries.length && entries[rawIdx].isHidden) {
      return -1; // ハイライトなし
    }
    return visibleIdx;
  }

  get isGm(): boolean {
    return this.gmModeService.isGm;
  }

  get entries(): CombatEntry[] {
    return this.initiativeService.getCombatEntries();
  }

  getVisibleEntries(): CombatEntry[] {
    if (this.isGm) return this.entries;
    // PL視点: 非公開コマはパネルから完全に隠す
    return this.entries.filter(e => !e.isHidden);
  }

  getCurrentTurnIdentifier(): string | null {
    return this.initiativeService.getCurrentTurnIdentifier();
  }

  nextTurn() {
    this.initiativeService.nextTurn();
  }

  prevTurn() {
    this.initiativeService.prevTurn();
  }

  toggleCollapse() {
    this.isCollapsed = !this.isCollapsed;
  }

  get turnMarkerVisible(): boolean {
    const tables = ObjectStore.instance.getObjects<GameTable>(GameTable);
    const table = tables.find(t => t.combatActive) || tables.find(t => t.selected) || tables[0];
    return table ? table.combatTurnMarkerVisible : false;
  }

  toggleTurnMarker() {
    const tables = ObjectStore.instance.getObjects<GameTable>(GameTable);
    const table = tables.find(t => t.combatActive) || tables.find(t => t.selected) || tables[0];
    if (!table) return;
    table.combatTurnMarkerVisible = !table.combatTurnMarkerVisible;
    table.update();
    EventSystem.trigger('COMBAT_STATE_CHANGED', {});
  }

  getCharacterIcon(identifier: string): string {
    const char = ObjectStore.instance.get<GameCharacter>(identifier);
    return char?.imageFile?.url || '';
  }

  isActed(identifier: string): boolean {
    return this.initiativeService.isActed(identifier);
  }

  toggleActed(identifier: string) {
    this.initiativeService.toggleActed(identifier);
  }

  trackById(index: number, entry: CombatEntry): string {
    return entry.identifier;
  }

  onDragStart(event: DragEvent, index: number) {
    if (!this.isGm) { event.preventDefault(); return; }
    this.dragIndex = index;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', String(index));
  }

  onDragOver(event: DragEvent, index: number) {
    if (!this.isGm) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    this.dragOverIndex = index;
  }

  onDragLeave(event: DragEvent) {
    this.dragOverIndex = -1;
  }

  onDrop(event: DragEvent, index: number) {
    event.preventDefault();
    if (!this.isGm || this.dragIndex < 0 || this.dragIndex === index) {
      this.dragIndex = -1;
      this.dragOverIndex = -1;
      return;
    }
    const order = this.initiativeService.getCombatOrder();
    const draggedId = order[this.dragIndex];
    if (!draggedId) return;
    // ドラッグ元を削除してドロップ位置に挿入
    const newOrder = order.filter(id => id !== draggedId);
    const insertPos = this.dragIndex < index ? index - 1 : index;
    newOrder.splice(insertPos, 0, draggedId);
    this.initiativeService.reorderCombat(newOrder);
    this.dragIndex = -1;
    this.dragOverIndex = -1;
  }

  onDragEnd(event: DragEvent) {
    this.dragIndex = -1;
    this.dragOverIndex = -1;
  }
}
