import { Component, NgZone, OnDestroy, OnInit, ChangeDetectorRef } from '@angular/core';
import { EventSystem } from '@udonarium/core/system';
import { ObjectStore } from '@udonarium/core/synchronize-object/object-store';
import { GameCharacter, AutoBuffEntry, AutoBuffOperation, BuffExpireTiming } from '@udonarium/game-character';
import { GameTable } from '@udonarium/game-table';
import { DataElement } from '@udonarium/data-element';
import { InitiativeService, CombatEntry } from 'service/initiative.service';
import { PanelService } from 'service/panel.service';
import { TabletopService } from 'service/tabletop.service';

interface BuffDisplay {
  id: string;
  name: string;
  shortLabel: string;
  rounds: number;
  expireTiming: BuffExpireTiming;
  triggerName: string;
  operation: AutoBuffOperation;
  isDebuff: boolean;
  isManual: boolean;
  rawElement?: DataElement;
  rawEntry?: AutoBuffEntry;
  characterId: string;
  value: number;
}

interface EffectRow {
  characterId: string;
  characterName: string;
  buffs: BuffDisplay[];
}

interface BuffBar {
  buff: BuffDisplay;
  startCol: number;
  span: number;
}

@Component({
  selector: 'effect-manager',
  templateUrl: './effect-manager.component.html',
  styleUrls: ['./effect-manager.component.css']
})
export class EffectManagerComponent implements OnInit, OnDestroy {
  // フィルタ
  filterCharacter: string = '';
  filterType: 'all' | 'buff' | 'debuff' = 'all';
  searchText: string = '';

  // 追加フォーム用
  showAddForm: boolean = false;
  addTargetCharacter: string = '';
  addName: string = '';
  addTargetStat: string = '';
  addOperation: AutoBuffOperation = 'add';
  addValue: number = 0;
  addRounds: number = 3;
  addExpireTiming: BuffExpireTiming = 'round_end';
  addTriggerId: string = '';

  // インライン展開用
  expandedBuffId: string | null = null;

  // チャパレ生成用
  showPaletteGen: boolean = false;
  palName: string = '';
  palTargetStat: string = '';
  palOperation: AutoBuffOperation = 'add';
  palValue: number = 0;
  palRounds: number = 3;
  palExpireTiming: BuffExpireTiming = 'round_end';
  palTriggerName: string = '';
  palTargetSelf: boolean = false;
  palGenerated: string = '';
  palCopied: boolean = false;

  private readonly maxRoundColumns = 10;

  operationLabels: { value: AutoBuffOperation; label: string }[] = [
    { value: 'add', label: '加算' },
    { value: 'append', label: '最大値追加' },
    { value: 'current', label: '現状記録' },
    { value: 'replace', label: '置換' },
    { value: 'create', label: '新規要素' },
    { value: 'palette', label: 'チャパレ' },
  ];

  expireTimingOptions: { value: BuffExpireTiming; label: string; icon: string }[] = [
    { value: 'round_end', label: 'ラウンド終了時', icon: '🔄' },
    { value: 'turn_start', label: 'トリガーキャラ手番開始時', icon: '▶' },
    { value: 'turn_end', label: 'トリガーキャラ手番終了時', icon: '⏹' },
  ];

  constructor(
    private initiativeService: InitiativeService,
    private panelService: PanelService,
    private tabletopService: TabletopService,
    private ngZone: NgZone,
    private changeDetector: ChangeDetectorRef
  ) {}

  ngOnInit() {
    EventSystem.register(this)
      .on('UPDATE_GAME_OBJECT', event => {
        const object = ObjectStore.instance.get(event.data.identifier);
        if (object instanceof GameCharacter || object instanceof GameTable || object instanceof DataElement) {
          this.ngZone.run(() => {
            this.changeDetector.markForCheck();
          });
        }
      })
      .on('COMBAT_STATE_CHANGED', () => {
        this.ngZone.run(() => {
          this.changeDetector.markForCheck();
        });
      });
  }

  ngOnDestroy() {
    EventSystem.unregister(this);
  }

  get isCombatActive(): boolean {
    return this.initiativeService.isCombatActive;
  }

  get isAdvancedMode(): boolean {
    return this.tabletopService.currentTable?.roomMode === 'advanced';
  }

  get currentRound(): number {
    return this.initiativeService.currentRound;
  }

  get roundColumns(): number[] {
    const cols: number[] = [];
    const start = this.currentRound;
    const count = Math.min(this.maxRoundColumns, 10);
    for (let i = 0; i < count; i++) {
      cols.push(start + i);
    }
    return cols;
  }

  get combatEntries(): CombatEntry[] {
    return this.initiativeService.getCombatEntries();
  }

  get combatCharacters(): { id: string; name: string }[] {
    return this.combatEntries.map(e => ({ id: e.identifier, name: e.name }));
  }

  get currentTurnCharId(): string {
    const order = this.initiativeService.getCombatOrder();
    const idx = this.initiativeService.currentTurnIndex;
    return order[idx] || '';
  }

  getEffectRows(): EffectRow[] {
    const entries = this.combatEntries;
    const rows: EffectRow[] = [];

    for (const entry of entries) {
      if (this.filterCharacter && entry.identifier !== this.filterCharacter) continue;

      const char = ObjectStore.instance.get<GameCharacter>(entry.identifier);
      if (!char) continue;

      const buffs = this.collectBuffs(char);
      const filtered = buffs.filter(b => {
        if (this.filterType === 'buff' && b.isDebuff) return false;
        if (this.filterType === 'debuff' && !b.isDebuff) return false;
        if (this.searchText) {
          const q = this.searchText.toLowerCase();
          if (!b.name.toLowerCase().includes(q) && !b.shortLabel.toLowerCase().includes(q)) return false;
        }
        return true;
      });

      if (filtered.length === 0 && (this.filterType !== 'all' || this.searchText)) continue;

      rows.push({
        characterId: entry.identifier,
        characterName: entry.name,
        buffs: filtered
      });
    }
    return rows;
  }

  private collectBuffs(char: GameCharacter): BuffDisplay[] {
    const result: BuffDisplay[] = [];
    const charId = char.identifier;

    // 自動計算バフ
    const autoBuffs = char.getAutoBuffs();
    for (const entry of autoBuffs) {
      const isDebuff = this.determineDebuff(entry);
      result.push({
        id: entry.id,
        name: entry.name,
        shortLabel: this.makeShortLabel(entry),
        rounds: entry.rounds,
        expireTiming: entry.expireTiming || 'round_end',
        triggerName: entry.triggerName || '',
        operation: entry.operation,
        isDebuff,
        isManual: false,
        rawEntry: entry,
        characterId: charId,
        value: entry.value
      });
    }

    // 手動バフ (DataElement)
    if (char.buffDataElement && char.buffDataElement.children) {
      const buffRoot = char.buffDataElement.children[0] as DataElement;
      if (buffRoot && buffRoot.children) {
        for (const child of buffRoot.children) {
          if (child instanceof DataElement) {
            const rounds = parseInt(child.value as string) || 0;
            const name = child.getAttribute('name') as string || '効果';
            const currentValue = child.currentValue as string || '';
            const isDebuff = this.determineManualDebuff(name, currentValue);
            const rawTiming = (child.getAttribute('expireTiming') as string) || 'round_end';
            const timing: BuffExpireTiming = (rawTiming === 'user_turn_start' || rawTiming === 'target_turn_start' || rawTiming === 'user_turn_end') ? 'round_end' : rawTiming as BuffExpireTiming;
            const triggerName = (child.getAttribute('triggerName') as string) || '';

            result.push({
              id: child.identifier,
              name,
              shortLabel: currentValue || `${rounds}R`,
              rounds,
              expireTiming: timing,
              triggerName,
              operation: 'add',
              isDebuff,
              isManual: true,
              rawElement: child,
              characterId: charId,
              value: 0
            });
          }
        }
      }
    }

    return result;
  }

  private determineDebuff(entry: AutoBuffEntry): boolean {
    if (entry.operation === 'palette') return false;
    return entry.value < 0;
  }

  private determineManualDebuff(name: string, info: string): boolean {
    const text = (name + ' ' + info).toLowerCase();
    if (text.includes('毒') || text.includes('dot') || text.includes('デバフ') || text.includes('害')) return true;
    return false;
  }

  private makeShortLabel(entry: AutoBuffEntry): string {
    const op = entry.operation;
    if (op === 'palette') return '🎲';
    if (op === 'create') return `${entry.targetStat || entry.name}`;
    if (op === 'replace') return `=${entry.value}`;
    if (op === 'current') return `記録:${entry.value}`;
    const sign = entry.value >= 0 ? '+' : '';
    return `${entry.targetStat || ''}${sign}${entry.value}`;
  }

  getBuffBars(characterId: string): BuffBar[] {
    const rows = this.getEffectRows();
    const row = rows.find(r => r.characterId === characterId);
    if (!row) return [];

    const bars: BuffBar[] = [];
    for (const buff of row.buffs) {
      const span = Math.max(1, buff.rounds);
      bars.push({
        buff,
        startCol: 0,
        span
      });
    }
    return bars;
  }

  getOperationLabel(op: AutoBuffOperation): string {
    switch (op) {
      case 'add': return '加算';
      case 'append': return '最大値追加';
      case 'current': return '現状記録';
      case 'replace': return '置換';
      case 'create': return '新規要素';
      case 'palette': return 'チャパレ';
    }
  }

  getExpireTimingIcon(timing?: BuffExpireTiming): string {
    switch (timing) {
      case 'round_end': return '🔄';
      case 'turn_start': return '▶';
      case 'turn_end': return '⏹';
      default: return '🔄';
    }
  }

  getExpireTimingLabel(timing?: BuffExpireTiming): string {
    switch (timing) {
      case 'round_end': return 'ラウンド終了';
      case 'turn_start': return '手番開始';
      case 'turn_end': return '手番終了';
      default: return 'ラウンド終了';
    }
  }

  // ===== クリックアクション =====

  onBarClick(buff: BuffDisplay) {
    this.expandedBuffId = this.expandedBuffId === buff.id ? null : buff.id;
  }

  isExpanded(buffId: string): boolean {
    return this.expandedBuffId === buffId;
  }

  getCharImageUrl(charId: string): string {
    const char = ObjectStore.instance.get<GameCharacter>(charId);
    if (!char || !char.imageFile) return '';
    return char.imageFile.url || '';
  }

  updateBuffRounds(buff: BuffDisplay, value: number) {
    const char = ObjectStore.instance.get<GameCharacter>(buff.characterId);
    if (!char) return;
    if (buff.isManual && buff.rawElement) {
      buff.rawElement.value = value;
      char.update();
    } else if (buff.rawEntry) {
      const buffs = char.getAutoBuffs();
      const entry = buffs.find(b => b.id === buff.id);
      if (entry) { entry.rounds = value; char['saveAutoBuffs'](buffs); }
    }
  }

  updateBuffName(buff: BuffDisplay, value: string) {
    const char = ObjectStore.instance.get<GameCharacter>(buff.characterId);
    if (!char) return;
    if (buff.isManual && buff.rawElement) {
      buff.rawElement.name = value;
      char.update();
    } else if (buff.rawEntry) {
      const buffs = char.getAutoBuffs();
      const entry = buffs.find(b => b.id === buff.id);
      if (entry) { entry.name = value; char['saveAutoBuffs'](buffs); }
    }
  }

  updateBuffValue(buff: BuffDisplay, value: number) {
    const char = ObjectStore.instance.get<GameCharacter>(buff.characterId);
    if (!char) return;
    if (buff.isManual && buff.rawElement) {
      buff.rawElement.currentValue = String(value);
      char.update();
    } else if (buff.rawEntry) {
      const buffs = char.getAutoBuffs();
      const entry = buffs.find(b => b.id === buff.id);
      if (entry && entry.operation !== 'palette' && entry.operation !== 'create' && entry.operation !== 'current') {
        entry.value = value;
        char['saveAutoBuffs'](buffs);
      }
    }
  }

  deleteBuff(buff: BuffDisplay) {
    const char = ObjectStore.instance.get<GameCharacter>(buff.characterId);
    if (!char) return;

    if (buff.isManual && buff.rawElement) {
      buff.rawElement.destroy();
      char.update();
    } else if (buff.rawEntry) {
      char.removeAutoBuff(buff.id);
    }
  }

  // ===== 追加フォーム =====

  toggleAddForm() {
    this.showAddForm = !this.showAddForm;
    if (this.showAddForm) {
      this.showPaletteGen = false;
      if (this.combatCharacters.length > 0) {
        this.addTargetCharacter = this.combatCharacters[0].id;
        this.addTriggerId = this.currentTurnCharId;
      }
    }
  }

  get availableStats(): string[] {
    if (!this.addTargetCharacter) return [];
    const char = ObjectStore.instance.get<GameCharacter>(this.addTargetCharacter);
    if (!char) return [];
    const stats: string[] = [];
    const collect = (parent: DataElement) => {
      if (!parent || !parent.children) return;
      for (const child of parent.children) {
        if (child instanceof DataElement) {
          if (child.children.length === 0 && (child.type === 'numberResource' || child.type === '')) {
            stats.push(child.name);
          } else if (child.children.length > 0) {
            collect(child);
          }
        }
      }
    };
    collect(char.detailDataElement);
    return stats;
  }

  addBuff() {
    if (!this.addTargetCharacter) return;
    const char = ObjectStore.instance.get<GameCharacter>(this.addTargetCharacter);
    if (!char) return;

    const name = (this.addName || '').trim() || '新規効果';
    const triggerChar = this.addTriggerId ? ObjectStore.instance.get<GameCharacter>(this.addTriggerId) : null;
    const triggerName = triggerChar ? triggerChar.name : '';

    if (this.addOperation === 'palette') {
      // チャパレは対象ステータス不要
    } else if (this.addOperation !== 'create' && !this.addTargetStat) {
      return;
    }

    char.applyAutoBuff(
      name,
      this.addOperation === 'palette' ? '' : this.addTargetStat,
      this.addOperation,
      this.addValue,
      this.addRounds,
      'リソース',
      'numberResource',
      this.addTriggerId || undefined,
      triggerName || undefined,
      this.addExpireTiming
    );

    // リセット
    this.addName = '';
    this.addValue = 0;
    this.addRounds = 3;
    this.addTargetStat = '';
    this.addOperation = 'add';
    this.addExpireTiming = 'round_end';
  }

  close() {
    this.panelService.close();
  }

  trackByCharId(index: number, row: EffectRow): string {
    return row.characterId;
  }

  trackByBuffId(index: number, bar: BuffBar): string {
    return bar.buff.id;
  }

  // ===== チャパレ生成 =====

  togglePaletteGen() {
    this.showPaletteGen = !this.showPaletteGen;
    if (this.showPaletteGen) {
      this.showAddForm = false;
      this.generatePaletteCommand();
    }
  }

  generatePaletteCommand() {
    const name = (this.palName || '').trim() || '新規バフ';
    const stat = this.palOperation === 'palette' ? '' : (this.palTargetStat || '');
    const op = this.palOperation;
    const val = this.palOperation === 'palette' ? 0 : (this.palValue || 0);
    const rounds = this.palRounds || 1;

    let cmd = this.palTargetSelf ? '&!' : 't&!';
    cmd += `${name}/${stat}/${op}/${val}/${rounds}`;

    if (this.palExpireTiming !== 'round_end') {
      cmd += `/${this.palExpireTiming}`;
      if (this.palTriggerName.trim()) {
        cmd += `/${this.palTriggerName.trim()}`;
      }
    }

    this.palGenerated = cmd;
    this.palCopied = false;
  }

  copyPaletteCommand() {
    if (!this.palGenerated) return;
    try {
      navigator.clipboard.writeText(this.palGenerated);
      this.palCopied = true;
    } catch (e) {
      // フォールバック
      const textarea = document.createElement('textarea');
      textarea.value = this.palGenerated;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      this.palCopied = true;
    }
  }

  /** 生成したコマンドを指定キャラのチャパレに追加 */
  addPaletteToCharacter() {
    if (!this.palGenerated || !this.combatCharacters.length) return;
    const charId = this.currentTurnCharId || this.combatCharacters[0]?.id;
    if (!charId) return;
    const char = ObjectStore.instance.get<GameCharacter>(charId);
    if (!char) return;

    const palette = char.chatPalette;
    if (!palette) return;

    const displayName = (this.palName || '').trim() || '新規バフ';
    // チャパレ文字列を取得して、新しい行を追加
    const currentPalette = <string>(palette.value || '');
    const newLine = `${displayName}\t${this.palGenerated}`;
    const newPalette = currentPalette ? currentPalette + '\n' + newLine : newLine;
    palette.setPalette(newPalette);
    palette.update();
    this.palCopied = true;
  }
}
