import { Component, NgZone, OnDestroy, OnInit } from '@angular/core';
import { trigger, transition, style, animate } from '@angular/animations';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { EventSystem } from '@udonarium/core/system';
import { ObjectStore } from '@udonarium/core/synchronize-object/object-store';
import { ChatMessage } from '@udonarium/chat-message';
import { ChatTab } from '@udonarium/chat-tab';
import { GameCharacter } from '@udonarium/game-character';
import { GameTable } from '@udonarium/game-table';

type DiceShape = 'd4' | 'd6' | 'd8' | 'd10' | 'd12' | 'd20' | 'd100';

interface SingleDiceResult {
  value: number;
  shape: DiceShape;
  discarded?: boolean;  // 有利/不利で捨てられたダイス
}

interface DiceCutinData {
  characterName: string;
  characterImage: string;
  diceExpression: string;
  diceResults: SingleDiceResult[];
  baseRollTotal: number;
  modifierValue: number;
  modifierBreakdown: string;
  modifier: string;
  total: number;
  isCritical: boolean;
  isFumble: boolean;
  isSuccess: boolean;
  isFailure: boolean;
  specialLabel: string;
  specialLabelClass: string;
}

@Component({
  selector: 'dice-cutin',
  templateUrl: './dice-cutin.component.html',
  styleUrls: ['./dice-cutin.component.css'],
  animations: [
    trigger('cutinAnimation', [
      transition(':enter', [
        style({ opacity: 0 }),
        animate('0.3s ease-out', style({ opacity: 1 }))
      ]),
      transition(':leave', [
        animate('0.3s ease-in', style({ opacity: 0 }))
      ])
    ])
  ]
})
export class DiceCutinComponent implements OnInit, OnDestroy {
  active: boolean = false;
  data: DiceCutinData = null;
  private hideTimer: any = null;

  get diceValuesText(): string {
    if (!this.data) return '';
    return this.data.diceResults.map(d => d.value).join(', ');
  }

  constructor(
    private ngZone: NgZone,
    private sanitizer: DomSanitizer
  ) {}

  ngOnInit() {
    EventSystem.register(this)
      .on('UPDATE_GAME_OBJECT', event => {
        const obj = ObjectStore.instance.get(event.data.identifier);
        if (!(obj instanceof ChatMessage)) return;
        if (!obj.isDicebot) return;
        // tryCutinは使わない。DICE_CUT_IN_STRUCTUREDで統一。
        // UPDATE_GAME_OBJECTは古いパスとして残すが、構造化イベントが既に処理済みならスキップ
      })
      .on('DICE_CUT_IN_STRUCTURED', event => {
        this.ngZone.run(() => { this.tryStructuredCutin(event.data.rollResult); });
      });
  }

  ngOnDestroy() {
    EventSystem.unregister(this);
    if (this.hideTimer) clearTimeout(this.hideTimer);
  }

  private get table(): GameTable {
    return ObjectStore.instance.getObjects<GameTable>(GameTable).find(t => t.selected) ||
      ObjectStore.instance.getObjects<GameTable>(GameTable)[0];
  }

  getDiceSvgSafe(shape: DiceShape): SafeHtml {
    return this.sanitizer.bypassSecurityTrustHtml(this.getRawDiceSvg(shape));
  }

  private getRawDiceSvg(shape: DiceShape): string {
    switch (shape) {
      case 'd4':
        return `<svg viewBox="0 0 60 60" xmlns="http://www.w3.org/2000/svg">
          <polygon points="30,4 4,54 56,54" fill="#f0e6d2" stroke="#8b7355" stroke-width="2"/>
          <polygon points="30,4 4,54 30,44" fill="#e8dcc8" stroke="#8b7355" stroke-width="1" opacity="0.5"/>
        </svg>`;
      case 'd6':
        return `<svg viewBox="0 0 60 60" xmlns="http://www.w3.org/2000/svg">
          <rect x="8" y="8" width="44" height="44" rx="6" fill="#f5f0e8" stroke="#8b7355" stroke-width="2"/>
          <rect x="12" y="12" width="36" height="36" rx="4" fill="#ece5d8" stroke="#8b7355" stroke-width="1" opacity="0.5"/>
        </svg>`;
      case 'd8':
        return `<svg viewBox="0 0 60 60" xmlns="http://www.w3.org/2000/svg">
          <polygon points="30,2 58,30 30,58 2,30" fill="#f0e6d2" stroke="#8b7355" stroke-width="2"/>
          <polygon points="30,2 58,30 30,30" fill="#e8dcc8" stroke="#8b7355" stroke-width="1" opacity="0.5"/>
        </svg>`;
      case 'd10':
        return `<svg viewBox="0 0 60 60" xmlns="http://www.w3.org/2000/svg">
          <polygon points="30,2 56,22 48,54 12,54 4,22" fill="#f0e6d2" stroke="#8b7355" stroke-width="2"/>
          <polygon points="30,2 56,22 30,30" fill="#e8dcc8" stroke="#8b7355" stroke-width="1" opacity="0.5"/>
        </svg>`;
      case 'd12':
        return `<svg viewBox="0 0 60 60" xmlns="http://www.w3.org/2000/svg">
          <polygon points="30,2 50,12 58,32 48,52 12,52 2,32 10,12" fill="#f0e6d2" stroke="#8b7355" stroke-width="2"/>
          <polygon points="30,2 50,12 30,30" fill="#e8dcc8" stroke="#8b7355" stroke-width="1" opacity="0.5"/>
        </svg>`;
      case 'd20':
        return `<svg viewBox="0 0 60 60" xmlns="http://www.w3.org/2000/svg">
          <polygon points="30,2 56,18 56,44 30,58 4,44 4,18" fill="#f0e6d2" stroke="#8b7355" stroke-width="2"/>
          <polygon points="30,2 56,18 30,30" fill="#e8dcc8" stroke="#8b7355" stroke-width="1" opacity="0.5"/>
          <polygon points="30,2 4,18 30,30" fill="#e0d4c0" stroke="#8b7355" stroke-width="1" opacity="0.3"/>
        </svg>`;
      case 'd100':
        return this.getRawDiceSvg('d10');
      default:
        return this.getRawDiceSvg('d6');
    }
  }

  private tryCutin(msg: ChatMessage) {
    const table = this.table;
    if (!table || table.roomMode !== 'advanced') return;
    if (!table.diceCutinEnabled) return;

    const text = msg.text || '';
    const parsed = this.parseDiceResult(text);
    if (!parsed) return;

    // 元のメッセージ（チャットパレットのコマンド）を探す
    let contextText = '';
    const tab = ObjectStore.instance.get<ChatTab>(msg.tabIdentifier);
    if (tab) {
      const siblings: ChatMessage[] = tab.chatMessages;
      const prevMsg = siblings.find(m => m.timestamp === msg.timestamp - 1 && m.from !== 'System-BCDice' && m.from !== 'System');
      if (prevMsg) {
        contextText = prevMsg.text || '';
      }
    }

    // キャラ画像を sender から探す
    let characterName = '';
    let characterImage = '';
    const senderName = msg.name ? msg.name.replace(/^<BCDice：/, '').replace(/>$/, '') : '';
    if (senderName) {
      const chars = ObjectStore.instance.getObjects<GameCharacter>(GameCharacter);
      const match = chars.find(c => c.name === senderName);
      if (match) {
        characterName = match.name;
        const img = match.imageFile;
        characterImage = (img && img.url && img.url.length > 0) ? img.url : '';
      }
      if (!characterName) characterName = senderName;
    }
    if (!characterName) characterName = '???';

    // 修正値の計算
    const baseRollTotal = parsed.diceResults.reduce((s, d) => s + d.value, 0);
    const modifierValue = parsed.total - baseRollTotal;
    const modifierBreakdown = modifierValue !== 0
      ? (modifierValue > 0 ? '+' + modifierValue : String(modifierValue))
      : '';

    // テキストから成功/失敗/特殊ラベルを抽出
    const isCritical = parsed.isCritical || /クリティカル|Critical|critical/.test(text);
    const isFumble = parsed.isFumble || /ファンブル|Fumble|fumble/.test(text);
    const isSuccess = /成功/.test(text);
    const isFailure = /失敗/.test(text);
    const specialLabel = this.extractSpecialLabel(text, isCritical, isFumble);
    const specialLabelClass = this.getLabelClass(specialLabel);

    this.data = {
      characterName,
      characterImage,
      diceExpression: contextText || parsed.expression,
      diceResults: parsed.diceResults,
      baseRollTotal,
      modifierValue,
      modifierBreakdown,
      modifier: parsed.modifier,
      total: parsed.total,
      isCritical,
      isFumble,
      isSuccess,
      isFailure,
      specialLabel,
      specialLabelClass,
    };
    this.active = true;
    this.startHideTimer();
  }

  /** 構造化データを使ったカットイン（DICE_CUT_IN_STRUCTUREDイベント用） */
  private tryStructuredCutin(rollResult: any) {
    const table = this.table;
    if (!table || table.roomMode !== 'advanced') return;
    if (!table.diceCutinEnabled) return;

    const text = (rollResult.result || '').replace(/[＞]/g, s => '→').trim();

    // 構造化データからダイス結果を構築（全ゲームシステム共通）
    const detailedRands = rollResult.detailedRands || [];
    const rands = rollResult.rands || [];

    const diceResults: SingleDiceResult[] = [];
    if (detailedRands.length > 0) {
      for (const dr of detailedRands) {
        if (dr.kind === 'normalDice') {
          diceResults.push({ value: dr.value, shape: this.sidesToShape(dr.sides) });
        }
      }
    } else if (rands.length > 0) {
      for (const [sides, value] of rands) {
        diceResults.push({ value, shape: this.sidesToShape(sides) });
      }
    }

    // ダイス値がない → テキストパースでフォールバック
    if (diceResults.length === 0) {
      const parsed = this.parseDiceResult(text);
      if (parsed) {
        diceResults.push(...parsed.diceResults);
      }
    }

    if (diceResults.length === 0 || diceResults.length > 20) return;

    // totalはテキストから抽出（最後の「→ 数字」）
    const total = this.extractTotal(text);
    const baseRollTotal = diceResults.reduce((s, d) => s + d.value, 0);

    // SW2.5の威力表ロール判定: 「2D:[...]」パターンがある場合
    // 出目を威力表で変換するため、修正値の計算が合わない → modifier非表示
    const isSW2PowerRoll = /\d+D:\[/.test(text);

    // 修正値の計算
    let modifierValue = 0;
    let modifierBreakdown = '';

    if (!isSW2PowerRoll) {
      // 通常ロール: テキストから明示的な修正値を探す
      modifierValue = total - baseRollTotal;
      modifierBreakdown = modifierValue !== 0
        ? (modifierValue > 0 ? '+' + modifierValue : String(modifierValue))
        : '';

      const textModifier = this.extractModifierFromText(text);
      if (textModifier !== null) {
        modifierValue = textModifier;
        modifierBreakdown = textModifier !== 0
          ? (textModifier > 0 ? '+' + textModifier : String(textModifier))
          : '';
      }

      // 有利/不利判定
      if (diceResults.length === 2 && textModifier !== null) {
        const chosenValue = total - textModifier;
        if (diceResults[0].value !== diceResults[1].value) {
          if (diceResults[0].value === chosenValue) {
            diceResults[1].discarded = true;
          } else if (diceResults[1].value === chosenValue) {
            diceResults[0].discarded = true;
          }
        }
      }
    }

    // キャラ画像を探す
    let characterName = '';
    let characterImage = '';
    const tabs = ObjectStore.instance.getObjects<ChatTab>(ChatTab);
    const activeTab = tabs.length > 0 ? tabs[0] : null;
    if (activeTab) {
      const msgs = activeTab.chatMessages;
      const lastMsg = msgs[msgs.length - 1];
      if (lastMsg && lastMsg.from === 'System-BCDice') {
        const senderName = lastMsg.name ? lastMsg.name.replace(/^<BCDice：/, '').replace(/>$/, '') : '';
        if (senderName) {
          const chars = ObjectStore.instance.getObjects<GameCharacter>(GameCharacter);
          const match = chars.find(c => c.name === senderName);
          if (match) {
            characterName = match.name;
            const img = match.imageFile;
            characterImage = (img && img.url && img.url.length > 0) ? img.url : '';
          }
          if (!characterName) characterName = senderName;
        }
      }
    }
    if (!characterName) characterName = '???';

    // 成功/失敗/クリティカル判定
    const isCritical = rollResult.isCritical || /クリティカル|Critical|critical/.test(text);
    const isFumble = rollResult.isFumble || /ファンブル|Fumble|fumble/.test(text);
    const isSuccess = rollResult.isSuccess || /成功/.test(text);
    const isFailure = rollResult.isFailure || /失敗/.test(text);
    const specialLabel = this.extractSpecialLabel(text, isCritical, isFumble);
    const specialLabelClass = this.getLabelClass(specialLabel);

    this.data = {
      characterName,
      characterImage,
      diceExpression: text.split('→')[0]?.trim() || '',
      diceResults,
      baseRollTotal,
      modifierValue,
      modifierBreakdown,
      modifier: modifierBreakdown,
      total,
      isCritical,
      isFumble,
      isSuccess,
      isFailure,
      specialLabel,
      specialLabelClass,
    };
    this.active = true;
    this.startHideTimer();
  }

  // ==================== テキストパーサー（旧parseDiceResultベース） ====================

  /**
   * BCDice結果テキストからダイス結果をパースする
   * 
   * 対応パターン:
   * Pattern A (有利/不利): "(AT+9A) → [14,7]+9 → 23"
   * Pattern B (標準ダイス): "(2d6+3) → 6[2,4]+3 → 9"
   * Pattern C (シンプル): "(1d100) → 45"
   * Pattern D (修飾なし): "(AT+9) → 16+9 → 25"
   */
  private parseDiceResult(text: string): {
    expression: string;
    diceResults: SingleDiceResult[];
    modifier: string;
    total: number;
    isCritical: boolean;
    isFumble: boolean;
  } | null {
    // Pattern A: 有利/不利 → [dice1,dice2]+mod → total
    const advantageMatch = text.match(/\(([^)]+)\)\s*[→＞]\s*\[([^\]]+)\]([^→＞]*?)[→＞]\s*(\d+)/);
    if (advantageMatch) {
      const expression = advantageMatch[1];
      const rawValues = advantageMatch[2].split(',').map(v => parseInt(v.trim(), 10)).filter(v => !isNaN(v));
      const modifier = advantageMatch[3].trim();
      const total = parseInt(advantageMatch[4], 10);
      if (rawValues.length > 20) return null;
      const shape = this.detectDiceShape(expression);
      const diceResults: SingleDiceResult[] = rawValues.map(v => ({ value: v, shape }));
      return { expression, diceResults, modifier, total, isCritical: this.checkCritical(expression, rawValues), isFumble: this.checkFumble(expression, rawValues) };
    }

    // Pattern B: 標準ダイス → total[dice1,dice2]+mod → total
    const fullMatch = text.match(/\(([^)]+)\)\s*[→＞]\s*(\d+)\[([^\]]*)\]([^→＞]*?)[→＞]\s*(\d+)/);
    if (fullMatch) {
      const expression = fullMatch[1];
      const rawValues = fullMatch[3].split(',').map(v => parseInt(v.trim(), 10)).filter(v => !isNaN(v));
      const modifier = fullMatch[4].trim();
      const total = parseInt(fullMatch[5], 10);
      if (rawValues.length > 20) return null;
      const shape = this.detectDiceShape(expression);
      const diceResults: SingleDiceResult[] = rawValues.map(v => ({ value: v, shape }));
      return { expression, diceResults, modifier, total, isCritical: this.checkCritical(expression, rawValues), isFumble: this.checkFumble(expression, rawValues) };
    }

    // Pattern D: 修飾なし → value+mod → total
    const plainMatch = text.match(/\(([^)]+)\)\s*[→＞]\s*(\d[\d+\-]*?)\s*[→＞]\s*(\d+)/);
    if (plainMatch) {
      const expression = plainMatch[1];
      const calcPart = plainMatch[2];
      const total = parseInt(plainMatch[3], 10);
      const shape = this.detectDiceShape(expression);
      const firstNum = parseInt(calcPart, 10);
      const diceResults: SingleDiceResult[] = !isNaN(firstNum) ? [{ value: firstNum, shape }] : [{ value: total, shape }];
      return { expression, diceResults, modifier: '', total, isCritical: this.checkCritical(expression, [firstNum]), isFumble: this.checkFumble(expression, [firstNum]) };
    }

    // Pattern C: シンプル → total
    const simpleMatch = text.match(/\(([^)]+)\)\s*[→＞]\s*(\d+)/);
    if (simpleMatch) {
      const expression = simpleMatch[1];
      const total = parseInt(simpleMatch[2], 10);
      const shape = this.detectDiceShape(expression);
      return { expression, diceResults: [{ value: total, shape }], modifier: '', total, isCritical: this.checkCritical(expression, [total]), isFumble: this.checkFumble(expression, [total]) };
    }

    // Pattern SW2: ソードワールド K20 等 (括弧なし)
    // "KeyNo.20c[5] → 2D:[5,2 2,6 3,2 1,6 6,4 1,2]=7,8,5,7,10,3 → 5,6,3,5,8,1 → 5回転 → 28"
    // "2d6 → 2D:[5,2]=7 → 7"
    const sw2Match = text.match(/(\S+)\s*[→＞]\s*(\d+)D:\[([^\]]+)\]/);
    if (sw2Match) {
      const expression = sw2Match[1];
      const diceCount = parseInt(sw2Match[2], 10);
      const rawValues = sw2Match[3].split(/[\s,]+/).map(v => parseInt(v.trim(), 10)).filter(v => !isNaN(v));
      // SW2.5は2D=6面ダイス
      const shape: DiceShape = 'd6';
      const diceResults: SingleDiceResult[] = rawValues.slice(0, 20).map(v => ({ value: v, shape }));
      const total = this.extractTotal(text);
      return { expression, diceResults, modifier: '', total, isCritical: false, isFumble: false };
    }

    // Pattern E: 汎用（括弧なし、→ 区切り）
    // "command → value → total" or "command → value"
    const genericMatch = text.match(/(\S+)\s*[→＞]\s*(\d+)\s*[→＞]\s*(\d+)/);
    if (genericMatch) {
      const expression = genericMatch[1];
      const diceValue = parseInt(genericMatch[2], 10);
      const total = parseInt(genericMatch[3], 10);
      const shape = this.detectDiceShape(expression);
      return { expression, diceResults: [{ value: diceValue, shape }], modifier: '', total, isCritical: false, isFumble: false };
    }

    // Pattern F: 単純「→ 数字」のみ
    const singleArrowMatch = text.match(/(\S+)\s*[→＞]\s*(\d+)/);
    if (singleArrowMatch) {
      const expression = singleArrowMatch[1];
      const total = parseInt(singleArrowMatch[2], 10);
      const shape = this.detectDiceShape(expression);
      return { expression, diceResults: [{ value: total, shape }], modifier: '', total, isCritical: false, isFumble: false };
    }

    return null;
  }

  // ==================== ヘルパー ====================

  private detectDiceShape(expression: string): DiceShape {
    const expr = expression.toLowerCase();
    if (expr.includes('d100')) return 'd100';
    if (expr.includes('d20')) return 'd20';
    if (expr.includes('d12')) return 'd12';
    if (expr.includes('d10')) return 'd10';
    if (expr.includes('d8')) return 'd8';
    if (expr.includes('d6')) return 'd6';
    if (expr.includes('d4')) return 'd4';
    // AT/AR/KD等のコマンドはd20系と推定
    return 'd20';
  }

  private sidesToShape(sides: number): DiceShape {
    if (sides === 4) return 'd4';
    if (sides === 6) return 'd6';
    if (sides === 8) return 'd8';
    if (sides === 10) return 'd10';
    if (sides === 12) return 'd12';
    if (sides === 20) return 'd20';
    if (sides === 100) return 'd100';
    return 'd20';
  }

  private checkCritical(expression: string, values: number[]): boolean {
    const d20Match = expression.match(/1d20/i);
    if (d20Match && values.length === 1 && values[0] === 20) return true;
    return false;
  }

  private checkFumble(expression: string, values: number[]): boolean {
    const d20Match = expression.match(/1d20/i);
    if (d20Match && values.length === 1 && values[0] === 1) return true;
    return false;
  }

  private extractSpecialLabel(text: string, isCritical: boolean, isFumble: boolean): string {
    let label = '';
    const rotationMatch = text.match(/(\d+)回転/);
    if (rotationMatch) label = rotationMatch[1] + '回転';
    if (!label && /スペシャル/.test(text)) label = 'スペシャル!';
    // SW2.5の自動的失敗（**を含むがクリティカルではない）
    if (!label && /自動的失敗/.test(text)) label = '自動的失敗...';
    if (!label && /絶対失敗/.test(text)) label = '絶対失敗...';
    if (!label && /自動失敗/.test(text)) label = '自動失敗...';
    if (!label && isCritical) label = 'クリティカル!';
    if (!label && isFumble) label = 'ファンブル...';
    if (!label && /絶対成功/.test(text)) label = '絶対成功!';
    if (!label && /自動成功/.test(text)) label = '自動成功!';
    if (!label && /大成功/.test(text)) label = '大成功!';
    if (!label && /大失敗/.test(text)) label = '大失敗...';
    if (!label && /超成功/.test(text)) label = '超成功!';
    if (!label && /超失敗/.test(text)) label = '超失敗...';
    if (!label && /劇的成功/.test(text)) label = '劇的成功!';
    if (!label && /劇的失敗/.test(text)) label = '劇的失敗...';
    // 失敗（成功より先に判定）
    if (!label && /失敗/.test(text)) label = '失敗...';
    if (!label && /成功/.test(text)) label = '成功!';
    return label;
  }

  private getLabelClass(label: string): string {
    if (/失敗|ファンブル/.test(label)) return 'label-failure';
    if (/成功|回転/.test(label)) return 'label-success';
    return 'label-special';
  }

  private extractTotal(text: string, diceResults?: SingleDiceResult[]): number {
    // 最後の「→ 数字」（全角矢印も対応）
    const arrowMatches = text.match(/[→＞]\s*(\d+)/g);
    if (arrowMatches) {
      const lastNum = arrowMatches[arrowMatches.length - 1];
      const numParse = lastNum.match(/(\d+)/);
      if (numParse) return parseInt(numParse[1], 10);
    }
    // テキスト末尾の数字
    const endMatch = text.match(/(\d+)\s*$/);
    if (endMatch) return parseInt(endMatch[1], 10);
    // フォールバック: ダイス合計
    if (diceResults) return diceResults.reduce((s, d) => s + d.value, 0);
    return 0;
  }

  /** テキスト中間部分から明示的な修正値を抽出
   * 例: "(AT+13A) → [3,5]+13 → 18" → +13
   * 例: "(2d6+3) → 6[2,4]+3 → 9" → +3
   * 例: "(AT+9) → 8+9 → 17" → +9
   * 例: "(10D6>=15) → 34[1,1,...] → 34 → 44" → null
   */
  private extractModifierFromText(text: string): number | null {
    const arrowParts = text.split(/[→＞]/);
    if (arrowParts.length < 3) return null;
    const middle = arrowParts[1].trim();
    // [dice1,dice2]+mod
    const bracketMod = middle.match(/\][^\d]*([+-]\d+)/);
    if (bracketMod) return parseInt(bracketMod[1], 10);
    // sum[dice1,dice2]+mod
    const sumBracketMod = middle.match(/\d+\[[^\]]*\][^\d]*([+-]\d+)/);
    if (sumBracketMod) return parseInt(sumBracketMod[1], 10);
    // value+mod (最初の数字の後ろ)
    const valueMod = middle.match(/^\d+([+-]\d+)/);
    if (valueMod) return parseInt(valueMod[1], 10);
    return null;
  }

  private startHideTimer() {
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.active = true;
    this.hideTimer = setTimeout(() => {
      this.active = false;
      this.data = null;
    }, 3500);
  }

  get animationState(): string {
    return this.active ? 'active' : 'inactive';
  }
}
