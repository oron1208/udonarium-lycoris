import { Injectable, NgZone } from '@angular/core';
import { EventSystem } from '@udonarium/core/system';
import { ObjectStore } from '@udonarium/core/synchronize-object/object-store';
import { GameCharacter } from '@udonarium/game-character';
import { GameCharacterGroup } from '@udonarium/game-character-group';
import { GameTable } from '@udonarium/game-table';
import { DataElement } from '@udonarium/data-element';
import { ChatMessageService } from './chat-message.service';
import { ChatTabList } from '@udonarium/chat-tab-list';
import { DiceBot } from '@udonarium/dice-bot';
import { TabletopSelectionService } from 'service/tabletop-selection.service';
import { TabletopService } from 'service/tabletop.service';
import { Logger } from '../class/core/system/util/logger';

export interface CombatEntry {
  identifier: string;
  name: string;
  initiative: number;
  isHidden: boolean; // GM非公開コマ
}

@Injectable({
  providedIn: 'root'
})
export class InitiativeService {
  constructor(
    private ngZone: NgZone,
    private chatMessageService: ChatMessageService,
    private tabletopSelectionService: TabletopSelectionService,
    private tabletopService: TabletopService
  ) {}

  /**
   * 戦闘がアクティブな場合はそのテーブルを返す。
   * 戦闘中にテーブルを切り替えても、元のテーブルの戦闘状態を維持する。
   * 戦闘がアクティブでない場合は選中テーブルを返す（新規戦闘開始用）。
   */
  private getCombatTable(): GameTable | null {
    const tables = ObjectStore.instance.getObjects<GameTable>(GameTable);
    // 戦闘中のテーブルがあれば、それを使う
    const activeTable = tables.find(t => t.combatActive);
    if (activeTable) return activeTable;
    // 戦闘中でなければ選中テーブルを返す
    return tables.find(t => t.selected) || tables[0] || null;
  }

  /**
   * 実際に選択中のテーブルを返す（戦闘開始時のBGM取得などで使用）
   */
  private getCurrentlySelectedTable(): GameTable | null {
    const tables = ObjectStore.instance.getObjects<GameTable>(GameTable);
    return tables.find(t => t.selected) || tables[0] || null;
  }

  private getSelectedTable(): GameTable | null {
    return this.getCombatTable();
  }

  get isCombatActive(): boolean {
    return this.getSelectedTable()?.combatActive ?? false;
  }

  get currentRound(): number {
    return this.getSelectedTable()?.combatRound ?? 1;
  }

  get currentTurnIndex(): number {
    return this.getSelectedTable()?.combatTurnIndex ?? 0;
  }

  getCombatOrder(): string[] {
    const table = this.getSelectedTable();
    if (!table) return [];
    try {
      return JSON.parse(table.combatOrder || '[]');
    } catch {
      return [];
    }
  }

  getActedSet(): Set<string> {
    const table = this.getSelectedTable();
    if (!table) return new Set();
    try {
      return new Set(JSON.parse(table.combatActedSet || '[]'));
    } catch {
      return new Set();
    }
  }

  private setActedSet(set: Set<string>) {
    const table = this.getSelectedTable();
    if (!table) return;
    table.combatActedSet = JSON.stringify([...set]);
    table.update();
    EventSystem.trigger('COMBAT_STATE_CHANGED', {});
  }

  toggleActed(identifier: string) {
    const set = this.getActedSet();
    if (set.has(identifier)) {
      set.delete(identifier);
    } else {
      set.add(identifier);
    }
    this.setActedSet(set);
  }

  isActed(identifier: string): boolean {
    return this.getActedSet().has(identifier);
  }

  clearActedSet() {
    this.setActedSet(new Set());
  }

  getCombatEntries(): CombatEntry[] {
    const order = this.getCombatOrder();
    return order.map(id => {
      const char = ObjectStore.instance.get<GameCharacter>(id);
      if (!char) {
        return { identifier: id, name: '(削除済み)', initiative: 0, isHidden: false };
      }
      return {
        identifier: id,
        name: char.name,
        initiative: char.initiative,
        isHidden: char.visibility !== 'public'
      };
    });
  }

  getCurrentTurnIdentifier(): string | null {
    const order = this.getCombatOrder();
    const idx = this.currentTurnIndex;
    if (order.length === 0 || idx < 0 || idx >= order.length) return null;
    return order[idx];
  }

  /**
   * 戦闘開始: テーブル上のキャラクターをイニシアチブ順に並べて戦闘モードON
   */
  startCombat() {
    const table = this.getSelectedTable();
    if (!table) return;

    // 戦闘開始設定に従って参加対象を集める
    // 通常キャラクター + キャラクターグループ(部位管理)。
    // グループは1枠として扱い、格納された部位は location.name='parts' で除外済み。
    const allTableChars: GameCharacter[] = [];
    for (const c of ObjectStore.instance.getObjects<GameCharacter>(GameCharacter)) {
      if (c.location.name === 'table') allTableChars.push(c);
    }
    for (const g of ObjectStore.instance.getObjects<GameCharacterGroup>(GameCharacterGroup)) {
      if (g.location.name === 'table') allTableChars.push(g);
    }
    const charMap: { [identifier: string]: GameCharacter } = {};

    if (table.combatJoinAllTableCharacters) {
      for (const char of allTableChars) charMap[char.identifier] = char;
    }

    if (table.combatJoinSelectedCharacters) {
      for (const char of allTableChars) {
        if (this.tabletopSelectionService.isSelected(char.identifier)) {
          charMap[char.identifier] = char;
        }
      }
    }

    let tableChars = Object.values(charMap);
    if (!table.combatIncludeHiddenInventoryCharacters) {
      tableChars = tableChars.filter(c => !c.hideInventory);
    }

    // イニシアチブ降順でソート
    tableChars.sort((a, b) => {
      const initA = a.initiative || 0;
      const initB = b.initiative || 0;
      if (initB !== initA) return initB - initA;
      // 同じイニシアチブの場合は名前順
      return a.name.localeCompare(b.name);
    });

    const order = tableChars.map(c => c.identifier);

    table.combatActive = true;
    table.combatRound = 1;
    table.combatTurnIndex = 0;
    table.combatOrder = JSON.stringify(order);
    table.update();

    // 戦闘開始BGM再生
    if (table.combatBgmIdentifier) {
      EventSystem.call('COMBAT_BGM_PLAY', { identifier: table.combatBgmIdentifier });
    }

    // 行動済みセットをクリア
    table.combatActedSet = '[]';

    // システムメッセージ
    const firstChar = tableChars[0];
    if (firstChar) {
      const firstName = this.getDisplayName(firstChar);
      this.sendCombatSystemMessage(`⚔️ 戦闘開始！ Round 1 — ${firstName}のターン`);
    } else {
      this.sendCombatSystemMessage('⚔️ 戦闘開始！ 参加キャラクターは手動で追加してください');
    }

    EventSystem.trigger('COMBAT_STATE_CHANGED', {});
  }

  /**
   * 戦闘終了
   */
  endCombat() {
    const table = this.getSelectedTable();
    if (!table) return;

    table.combatActive = false;
    table.combatRound = 1;
    table.combatTurnIndex = 0;
    table.combatOrder = '[]';
    table.combatActedSet = '[]';
    table.update();

    // 戦闘終了BGM停止
    EventSystem.call('COMBAT_BGM_STOP', {});

    this.sendCombatSystemMessage('⚔️ 戦闘終了！');

    EventSystem.trigger('COMBAT_STATE_CHANGED', {});
  }

  /**
   * 次のターンへ（行動済みスキップ、ラウンド跨ぎなし）
   */
  nextTurn() {
    const table = this.getSelectedTable();
    if (!table || !table.combatActive) return;

    const order = this.getCombatOrder();
    if (order.length === 0) return;

    // 現在のキャラを行動済みにする
    const actedSet = this.getActedSet();
    const currentId = order[table.combatTurnIndex];
    if (currentId) actedSet.add(currentId);

    // 行動済みでない次のキャラを探す
    let nextIndex = table.combatTurnIndex;
    let found = false;
    for (let i = 0; i < order.length; i++) {
      nextIndex = (nextIndex + 1) % order.length;
      if (!actedSet.has(order[nextIndex])) { found = true; break; }
    }

    if (!found) {
      // 全員行動済みなら次ラウンドへ
      // ただし最後のキャラの turn_end バフを先に処理する(部位含む)
      if (table.roomMode === 'advanced' && table.combatAutoBuffDecay && currentId) {
        this.decayBuffsForOrder(order, 'turn_end', currentId);
      }
      // 範囲バフの turn_end 処理（最後のキャラをトリガーとする）
      if (table.roomMode === 'advanced' && currentId) {
        for (const range of this.tabletopService.ranges) {
          if (!range.areaBuffEnabled || !range.areaBuffConfirmed) continue;
          if (range.areaBuffExpireTiming === 'turn_end' && range.areaBuffTriggerIdentifier === currentId) {
            range.areaBuffRounds = (range.areaBuffRounds || 1) - 1;
            if (range.areaBuffRounds <= 0) {
              range.areaBuffEnabled = false;
              range.areaBuffConfirmed = false;
              this.tabletopService.clearAreaBuff(range);
            } else {
              range.update();
            }
          }
        }
        this.tabletopService.updateAreaBuffs();
      }
      this.nextRound();
      return;
    }

    table.combatActedSet = JSON.stringify([...actedSet]);
    table.combatTurnIndex = nextIndex;
    table.update();

    const currentChar = ObjectStore.instance.get<GameCharacter>(order[nextIndex]);
    const name = currentChar ? this.getDisplayName(currentChar) : '';
    this.sendCombatSystemMessage(`⚔️ Round ${table.combatRound} — ${name}のターン`);

    // ターン切替時のバフ減少処理（アドバンスモード用）
    const turnCharId = order[nextIndex];
    if (table.roomMode === 'advanced' && table.combatAutoBuffDecay) {
      // 前のターンキャラの turn_end バフを先に処理
      if (currentId) {
        for (const id of order) {
          const char = ObjectStore.instance.get<GameCharacter>(id);
          if (!char) continue;
          char.decreaseAutoBuffRoundsByTrigger(currentId, 'turn_end');
          char.decreaseBuffRound('turn_end', currentId);
          char.deleteZeroRoundBuff();
        }
      }
      // 新ターンキャラの turn_start バフを処理
      for (const id of order) {
        const char = ObjectStore.instance.get<GameCharacter>(id);
        if (!char) continue;
        char.decreaseAutoBuffRoundsByTrigger(turnCharId, 'turn_start');
        char.decreaseBuffRound('turn_start', turnCharId);
        char.deleteZeroRoundBuff();
      }
    }

    // 範囲バフの turn_end / turn_start 処理（アドバンスモード用）
    if (table.roomMode === 'advanced') {
      // 前のターンキャラの turn_end 範囲バフを処理
      if (currentId) {
        for (const range of this.tabletopService.ranges) {
          if (!range.areaBuffEnabled || !range.areaBuffConfirmed) continue;
          if (range.areaBuffExpireTiming === 'turn_end' && range.areaBuffTriggerIdentifier === currentId) {
            range.areaBuffRounds = (range.areaBuffRounds || 1) - 1;
            if (range.areaBuffRounds <= 0) {
              range.areaBuffEnabled = false;
              range.areaBuffConfirmed = false;
              this.tabletopService.clearAreaBuff(range);
            } else {
              range.update();
            }
          }
        }
      }
      // 新ターンキャラの turn_start 範囲バフを処理
      for (const range of this.tabletopService.ranges) {
        if (!range.areaBuffEnabled || !range.areaBuffConfirmed) continue;
        if (range.areaBuffExpireTiming === 'turn_start' && range.areaBuffTriggerIdentifier === turnCharId) {
          range.areaBuffRounds = (range.areaBuffRounds || 1) - 1;
          if (range.areaBuffRounds <= 0) {
            range.areaBuffEnabled = false;
            range.areaBuffConfirmed = false;
            this.tabletopService.clearAreaBuff(range);
          } else {
            range.update();
          }
        }
      }
      this.tabletopService.updateAreaBuffs();
    }

    EventSystem.trigger('COMBAT_STATE_CHANGED', {});
  }

  /**
   * 次のラウンドへ
   */
  nextRound() {
    const table = this.getSelectedTable();
    if (!table || !table.combatActive) return;

    const order = this.getCombatOrder();
    if (order.length === 0) return;

    const oldRound = table.combatRound;
    table.combatActedSet = '[]';
    table.combatTurnIndex = 0;
    table.combatRound = oldRound + 1;
    table.update();
    EventSystem.trigger('COMBAT_ROUND_END', { round: oldRound });

    // バフR自動減少（アドバンスモード用）— round_end タイミングのみ(部位含む)
    if (table.roomMode === 'advanced' && table.combatAutoBuffDecay) {
      this.decayBuffsForOrder(order, 'round_end');
    }

    // 範囲バフのラウンド管理（アドバンスモード用）— round_end タイミングのみ
    if (table.roomMode === 'advanced') {
      for (const range of this.tabletopService.ranges) {
        if (!range.areaBuffEnabled || !range.areaBuffConfirmed) continue;
        const timing = range.areaBuffExpireTiming || 'round_end';
        if (timing !== 'round_end') continue;
        range.areaBuffRounds = (range.areaBuffRounds || 1) - 1;
        if (range.areaBuffRounds <= 0) {
          range.areaBuffEnabled = false;
          range.areaBuffConfirmed = false;
          this.tabletopService.clearAreaBuff(range);
        } else {
          range.update();
        }
      }
      this.tabletopService.updateAreaBuffs();
    }

    const currentChar = ObjectStore.instance.get<GameCharacter>(order[0]);
    const name = currentChar ? this.getDisplayName(currentChar) : '';
    this.sendCombatSystemMessage(`⚔️ Round ${table.combatRound} — ${name}のターン`);
    EventSystem.trigger('COMBAT_STATE_CHANGED', {});
  }

  /**
   * 前のラウンドへ
   */
  prevRound() {
    const table = this.getSelectedTable();
    if (!table || !table.combatActive) return;
    if (table.combatRound <= 1) return;

    const order = this.getCombatOrder();
    if (order.length === 0) return;

    table.combatActedSet = '[]';
    table.combatTurnIndex = 0;
    table.combatRound--;
    table.update();

    const currentChar = ObjectStore.instance.get<GameCharacter>(order[0]);
    const name = currentChar ? this.getDisplayName(currentChar) : '';
    this.sendCombatSystemMessage(`⚔️ Round ${table.combatRound} — ${name}のターン`);
    EventSystem.trigger('COMBAT_STATE_CHANGED', {});
  }

  /**
   * 前のターンに戻る
   */
  prevTurn() {
    const table = this.getSelectedTable();
    if (!table || !table.combatActive) return;

    const order = this.getCombatOrder();
    if (order.length === 0) return;

    let prevIndex = table.combatTurnIndex - 1;
    let prevRound = table.combatRound;

    if (prevIndex < 0) {
      prevIndex = order.length - 1;
      prevRound = Math.max(1, prevRound - 1);
    }

    table.combatTurnIndex = prevIndex;
    table.combatRound = prevRound;
    table.update();

    const currentChar = ObjectStore.instance.get<GameCharacter>(order[prevIndex]);
    const name = currentChar ? this.getDisplayName(currentChar) : '';
    this.sendCombatSystemMessage(`⚔️ Round ${prevRound} — ${name}のターン`);

    EventSystem.trigger('COMBAT_STATE_CHANGED', {});
  }

  /**
   * 指定したキャラクターを戦闘順序から削除
   */
  removeFromCombat(identifier: string) {
    const table = this.getSelectedTable();
    if (!table) return;

    const order = this.getCombatOrder();
    const idx = order.indexOf(identifier);
    if (idx === -1) return;

    order.splice(idx, 1);

    // currentTurnIndexの調整
    if (idx < table.combatTurnIndex) {
      table.combatTurnIndex--;
    } else if (idx === table.combatTurnIndex) {
      // 現在のターンのキャラを削除した場合
      if (table.combatTurnIndex >= order.length) {
        table.combatTurnIndex = 0;
      }
    }

    table.combatOrder = JSON.stringify(order);
    table.update();

    EventSystem.trigger('COMBAT_STATE_CHANGED', {});
  }

  /**
   * キャラクターを戦闘順序に追加
   */
  addToCombat(identifier: string) {
    const table = this.getSelectedTable();
    if (!table) return;

    const order = this.getCombatOrder();
    if (order.includes(identifier)) return;

    const char = ObjectStore.instance.get<GameCharacter>(identifier);
    if (!char) return;

    // イニシアチブ順の適切な位置に挿入
    const newInit = char.initiative || 0;
    let insertIdx = order.length;
    for (let i = 0; i < order.length; i++) {
      const existing = ObjectStore.instance.get<GameCharacter>(order[i]);
      const existingInit = existing ? (existing.initiative || 0) : 0;
      if (newInit > existingInit) {
        insertIdx = i;
        break;
      }
    }

    order.splice(insertIdx, 0, identifier);
    table.combatOrder = JSON.stringify(order);
    table.update();

    EventSystem.trigger('COMBAT_STATE_CHANGED', {});
  }

  /**
   * イニシアチブ値で戦闘順序を再ソート
   */
  resortCombatByInitiative() {
    const table = this.getSelectedTable();
    if (!table || !table.combatActive) return;

    const order = this.getCombatOrder();
    const chars = order.map(id => ObjectStore.instance.get<GameCharacter>(id)).filter(c => c);
    chars.sort((a, b) => (b.initiative || 0) - (a.initiative || 0));
    this.reorderCombat(chars.map(c => c.identifier));
  }

  /**
   * 順序を手動で並び替え
   */
  reorderCombat(newOrder: string[]) {
    const table = this.getSelectedTable();
    if (!table) return;

    // 現在のターンのキャラを記憶
    const oldOrder = this.getCombatOrder();
    const currentId = oldOrder[table.combatTurnIndex] || null;

    table.combatOrder = JSON.stringify(newOrder);

    // 現在のターンのキャラのインデックスを更新
    if (currentId) {
      const newIdx = newOrder.indexOf(currentId);
      if (newIdx >= 0) {
        table.combatTurnIndex = newIdx;
      }
    }

    table.update();
    EventSystem.trigger('COMBAT_STATE_CHANGED', {});
  }

  /**
   * 戦闘開始BGMを設定（現在選択中のテーブルに設定）
   */
  setCombatBgm(identifier: string) {
    const table = this.getCurrentlySelectedTable();
    if (!table) return;
    table.combatBgmIdentifier = identifier;
    table.update();
  }

  private sendCombatSystemMessage(text: string) {
    const chatTabList = ObjectStore.instance.get<ChatTabList>('ChatTabList');
    const tabs = chatTabList ? chatTabList.chatTabs : [];
    const sysTab = this.combatMessageTabId
      ? tabs.find(t => t.identifier === this.combatMessageTabId) || (chatTabList ? chatTabList.systemMessageTab : null)
      : (chatTabList ? chatTabList.systemMessageTab : null);
    this.chatMessageService.sendSystemMessage(sysTab, text, '#8B0000');
  }

  combatMessageTabId: string = '';

  private getDisplayName(char: GameCharacter): string {
    if (!char) return '';
    if ((char.visibility || 'public') === 'gmOnly') return '???';
    return char.name;
  }

  /**
   * イニシアチブ計算式を評価して値を返す
   * chatPalette.dicebotのゲームシステムでBCDice評価
   */
  async rollInitiativeFormulaAsync(char: GameCharacter): Promise<{ value: number; detail: string } | null> {
    const formula = char.initiativeFormula;
    Logger.debug('[InitiativeRoll] start', char.name, 'formula:', formula, 'dicebot:', char.chatPalette?.dicebot);
    if (!formula || !formula.trim()) return null;

    // {パラメータ名} を解決（チャパレのevaluateを使用）
    let resolved = formula;
    if (char.chatPalette) {
      resolved = char.chatPalette.evaluate(formula, char.rootDataElement, char, false);
    } else {
      resolved = this.resolveFormulaVariables(formula, char);
    }

    // ゲームシステムを取得してBCDiceで評価
    const gameType = char.chatPalette?.dicebot || 'DiceBot';
    try {
      const gameSystem = await DiceBot.loadGameSystemAsync(gameType);
      const rollResult = await DiceBot.diceRollAsync(resolved, gameSystem);
      Logger.debug('[InitiativeRoll]', char.name, 'gameType:', gameType, 'resolved:', resolved, 'result:', rollResult?.result);
      if (rollResult && rollResult.result) {
        const value = this.extractNumber(rollResult.result);
        return { value, detail: `${formula} → ${rollResult.result}` };
      }
    } catch (e) {
      Logger.warn('rollInitiativeFormulaAsync error', e);
    }

    // フォールバック: 簡易評価
    return this.rollInitiativeFormulaSimple(char);
  }

  /**
   * イニシアチブ計算式を簡易評価（フォールバック用）
   */
  rollInitiativeFormula(char: GameCharacter): { value: number; detail: string } | null {
    const formula = char.initiativeFormula;
    if (!formula || !formula.trim()) return null;

    const resolved = this.resolveFormulaVariables(formula, char);

    if (/\d*d\d+/i.test(resolved)) {
      const detail = this.evaluateDiceExpression(resolved);
      const value = this.extractNumber(detail);
      return { value, detail: `${formula} → ${resolved} → ${value}` };
    } else {
      try {
        const cleaned = resolved.replace(/[^0-9+\-*/().\s]/g, '');
        if (!cleaned.trim()) return null;
        const value = eval(cleaned);
        if (typeof value === 'number' && isFinite(value)) {
          return { value: Math.floor(value), detail: `${formula} → ${value}` };
        }
      } catch {
        return null;
      }
    }
    return null;
  }

  private rollInitiativeFormulaSimple(char: GameCharacter): { value: number; detail: string } | null {
    return this.rollInitiativeFormula(char);
  }

  /**
   * {パラメータ名} をキャラクターのステータス値で置換
   */
  resolveFormulaVariables(formula: string, char: GameCharacter): string {
    return formula.replace(/[\{｛]\s*([^\{｝]+)\s*[\}｝]/g, (match, name) => {
      const trimmed = name.trim();
      // パレット変数から検索
      if (char?.chatPalette) {
        for (let variable of char.chatPalette.paletteVariables) {
          if (variable.name === trimmed) return variable.value;
        }
      }
      // コマデータ要素から検索（common + detail統合）
      let element = char.rootDataElement.getFirstElementByName(trimmed);
      if (element) {
        return element.isNumberResource ? (element.currentValue + '') : (element.value + '');
      }
      return '0';
    });
  }

  private findStatusValue(char: GameCharacter, name: string, fromDetail: boolean = false): number | null {
    const dataElement = fromDetail ? char.detailDataElement : char.commonDataElement;
    if (!dataElement) return null;
    const elm = dataElement.getFirstElementByName(name);
    if (!elm) return null;
    const num = Number(elm.value);
    if (isNaN(num)) return null;
    return num;
  }

  /**
   * 簡易ダイス式評価 (XdY+Z形式)
   */
  evaluateDiceExpression(expr: string): string {
    // BCDiceを使わず簡易評価: XdY+Z を計算
    let result = 0;
    const cleaned = expr.replace(/\s/g, '');
    const parts = cleaned.match(/([+-]?)(\d*d?\d+)/gi) || [];
    let detail = '';
    for (const part of parts) {
      const sign = part.startsWith('-') ? -1 : 1;
      const token = part.replace(/^[+-]/, '');
      if (/^(\d+)d(\d+)$/i.test(token)) {
        const m = /^(\d+)d(\d+)$/i.exec(token);
        const count = parseInt(m[1]);
        const sides = parseInt(m[2]);
        let sum = 0;
        const rolls = [];
        for (let i = 0; i < count; i++) {
          const roll = Math.floor(Math.random() * sides) + 1;
          rolls.push(roll);
          sum += roll;
        }
        result += sign * sum;
        detail += `${sign > 0 ? '+' : '-'}${token}[${rolls.join(',')}]`;
      } else {
        const num = parseInt(token);
        if (!isNaN(num)) {
          result += sign * num;
          detail += `${sign > 0 ? '+' : '-'}${num}`;
        }
      }
    }
    return `${detail} = ${result}`;
  }

  extractNumber(detail: string): number {
    const m = /=?\s*(-?\d+)\s*$/.exec(detail);
    return m ? parseInt(m[1]) : 0;
  }

  /**
   * バフ自動減少処理。combatOrder のキャラ + グループ内の部位も対象にする。
   * 部位は location.name='parts' で combatOrder に入らないため、
   * グループのターン/ラウンド経過で部位のバフも減らす。
   */
  private decayBuffsForOrder(
    order: string[],
    mode: 'turn_end' | 'round_end',
    triggerId?: string,
  ) {
    for (const id of order) {
      const char = ObjectStore.instance.get<GameCharacter>(id);
      if (!char) continue;
      // グループなら部位も処理
      const targets: GameCharacter[] = (char instanceof GameCharacterGroup) ? char.parts : [char];
      for (const target of targets) {
        if (mode === 'turn_end' && triggerId) {
          target.decreaseAutoBuffRoundsByTrigger(triggerId, 'turn_end');
          target.decreaseBuffRound('turn_end', triggerId);
        } else {
          target.decreaseBuffRound('round_end');
          target.decreaseAutoBuffRounds();
        }
        target.deleteZeroRoundBuff();
      }
    }
  }
}
