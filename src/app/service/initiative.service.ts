import { Injectable, NgZone } from '@angular/core';
import { EventSystem } from '@udonarium/core/system';
import { ObjectStore } from '@udonarium/core/synchronize-object/object-store';
import { GameCharacter } from '@udonarium/game-character';
import { GameTable } from '@udonarium/game-table';
import { DataElement } from '@udonarium/data-element';
import { ChatMessageService } from './chat-message.service';
import { ChatTabList } from '@udonarium/chat-tab-list';

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
    private chatMessageService: ChatMessageService
  ) {}

  private getSelectedTable(): GameTable | null {
    const tables = ObjectStore.instance.getObjects<GameTable>(GameTable);
    return tables.find(t => t.selected) || tables[0] || null;
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

    // テーブル上のキャラクターを取得
    const tableChars = ObjectStore.instance.getObjects<GameCharacter>(GameCharacter)
      .filter(c => c.location.name === 'table');

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
      EventSystem.trigger('COMBAT_BGM_PLAY', { identifier: table.combatBgmIdentifier });
    }

    // システムメッセージ
    const firstChar = tableChars[0];
    const firstName = firstChar ? this.getDisplayName(firstChar) : '';
    this.sendCombatSystemMessage(`⚔️ 戦闘開始！ Round 1 — ${firstName}のターン`);

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
    table.update();

    // 戦闘終了BGM停止
    EventSystem.trigger('COMBAT_BGM_STOP', {});

    this.sendCombatSystemMessage('⚔️ 戦闘終了！');

    EventSystem.trigger('COMBAT_STATE_CHANGED', {});
  }

  /**
   * 次のターンへ
   */
  nextTurn() {
    const table = this.getSelectedTable();
    if (!table || !table.combatActive) return;

    const order = this.getCombatOrder();
    if (order.length === 0) return;

    let nextIndex = table.combatTurnIndex + 1;
    let nextRound = table.combatRound;

    if (nextIndex >= order.length) {
      nextIndex = 0;
      nextRound++;
      // ラウンド終了時のバフ処理など
      EventSystem.trigger('COMBAT_ROUND_END', { round: table.combatRound });
    }

    table.combatTurnIndex = nextIndex;
    table.combatRound = nextRound;
    table.update();

    const currentChar = ObjectStore.instance.get<GameCharacter>(order[nextIndex]);
    const name = currentChar ? this.getDisplayName(currentChar) : '';
    this.sendCombatSystemMessage(`⚔️ Round ${nextRound} — ${name}のターン`);

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
   * 戦闘開始BGMを設定
   */
  setCombatBgm(identifier: string) {
    const table = this.getSelectedTable();
    if (!table) return;
    table.combatBgmIdentifier = identifier;
    table.update();
  }

  private sendCombatSystemMessage(text: string) {
    const chatTabList = ObjectStore.instance.get<ChatTabList>('ChatTabList');
    const sysTab = chatTabList ? chatTabList.systemMessageTab : null;
    this.chatMessageService.sendSystemMessage(sysTab, text, '#8B0000');
  }

  private getDisplayName(char: GameCharacter): string {
    if (!char) return '';
    if ((char.visibility || 'public') === 'gmOnly') return '???';
    return char.name;
  }

  /**
   * イニシアチブ計算式を評価して値を返す
   * 例: "1d20+{敏捷度}" → ダイスロール + 敏捷度の値
   * 例: "15" → 固定値15
   */
  rollInitiativeFormula(char: GameCharacter): { value: number; detail: string } | null {
    const formula = char.initiativeFormula;
    if (!formula || !formula.trim()) return null;

    // {パラメータ名} を解決
    const resolved = this.resolveFormulaVariables(formula, char);

    // ダイス式か判定
    if (/\d*d\d+/i.test(resolved)) {
      // ダイスロール
      const detail = this.evaluateDiceExpression(resolved);
      const value = this.extractNumber(detail);
      return { value, detail: `${formula} → ${resolved} → ${value}` };
    } else {
      // 固定値または数式
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

  /**
   * {パラメータ名} をキャラクターのステータス値で置換
   */
  resolveFormulaVariables(formula: string, char: GameCharacter): string {
    return formula.replace(/[\{｛]\s*([^\{｝]+)\s*[\}｝]/g, (match, name) => {
      const trimmed = name.trim();
      // commonから探す
      let val = this.findStatusValue(char, trimmed);
      if (val === null) val = this.findStatusValue(char, trimmed, true); // detailから
      if (val === null) return '0';
      return String(val);
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
}
