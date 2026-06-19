import { Component, NgZone, OnDestroy, OnInit } from '@angular/core';
import { EventSystem } from '@udonarium/core/system';
import { ObjectStore } from '@udonarium/core/synchronize-object/object-store';
import { GameCharacter } from '@udonarium/game-character';
import { GameTable } from '@udonarium/game-table';
import { InitiativeService, CombatEntry } from 'service/initiative.service';
import { PanelService } from 'service/panel.service';
import { GmModeService } from 'service/gm-mode.service';
import { PointerDeviceService } from 'service/pointer-device.service';
import { ContextMenuService } from 'service/context-menu.service';

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
    return this.initiativeService.currentTurnIndex;
  }

  get isGm(): boolean {
    return this.gmModeService.isGm;
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

  rollInitiativeForAll() {
    const order = this.initiativeService.getCombatOrder();
    const visibleResults: string[] = [];
    const gmResults: string[] = [];
    for (const id of order) {
      const char = ObjectStore.instance.get<GameCharacter>(id);
      if (!char) continue;
      const formulaResult = this.initiativeService.rollInitiativeFormula(char);
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
}
