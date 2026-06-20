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
}
