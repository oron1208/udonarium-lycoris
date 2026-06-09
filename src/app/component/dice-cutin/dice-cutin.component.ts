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
}

interface DiceCutinData {
  characterName: string;
  characterImage: string;
  diceExpression: string;
  diceResults: SingleDiceResult[];
  modifier: string;
  total: number;
  isCritical: boolean;
  isFumble: boolean;
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
        this.ngZone.run(() => { this.tryCutin(obj); });
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
    console.log('DiceCutin: msg.name=' + msg.name + ' msg.from=' + msg.from);
    const senderName = msg.name ? msg.name.replace(/^<BCDice：/, '').replace(/>$/, '') : '';
    if (senderName) {
      const chars = ObjectStore.instance.getObjects<GameCharacter>(GameCharacter);
      console.log('DiceCutin: looking for char "' + senderName + '" among ' + chars.length + ' chars');
      const match = chars.find(c => c.name === senderName);
      if (match) {
        characterName = match.name;
        const img = match.imageFile;
        console.log('DiceCutin: found char, imageFile=' + (img ? img.url : 'null'));
        characterImage = (img && img.url && img.url.length > 0) ? img.url : '';
      } else {
        console.log('DiceCutin: char not found for name "' + senderName + '"');
      }
    }
    if (!characterName) characterName = senderName || '???';

    this.data = {
      characterName,
      characterImage,
      diceExpression: contextText || parsed.expression,
      diceResults: parsed.diceResults,
      modifier: parsed.modifier,
      total: parsed.total,
      isCritical: parsed.isCritical,
      isFumble: parsed.isFumble,
    };
    this.active = true;
    this.startHideTimer();
  }

  private detectDiceShape(expression: string): DiceShape {
    const expr = expression.toLowerCase();
    if (expr.includes('d100')) return 'd100';
    if (expr.includes('d20')) return 'd20';
    if (expr.includes('d12')) return 'd12';
    if (expr.includes('d10')) return 'd10';
    if (expr.includes('d8')) return 'd8';
    if (expr.includes('d6')) return 'd6';
    if (expr.includes('d4')) return 'd4';
    return 'd6';
  }

  private parseDiceResult(text: string): {
    expression: string;
    diceResults: SingleDiceResult[];
    modifier: string;
    total: number;
    isCritical: boolean;
    isFumble: boolean;
  } | null {
    // BCDice result formats:
    // Pattern A (有利/不利): "(AT+9A) → [14,7]+9 → 23"
    // Pattern B (標準ダイス): "(2d6+3) → 6[2,4]+3 → 9"
    // Pattern C (シンプル): "(1d100) → 45"
    // Pattern D (修飾なし): "(AT+9) → 16+9 → 25"
    // Pattern E (＞記号): "(1D10+8+2) ＞ 3[3]+8+2 ＞ 23"

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
      // calcPartからダイス値を抽出（最初の数字）
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

    return null;
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

  private startHideTimer() {
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.active = true;
    this.hideTimer = setTimeout(() => {
      this.active = false;
      this.data = null;
    }, 3500);
  }

  // CSSアニメーションをリセットするためのヘルパー
  get animationState(): string {
    return this.active ? 'active' : 'inactive';
  }
}
