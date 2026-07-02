import { Component, NgZone, OnDestroy, OnInit } from '@angular/core';
import { trigger, transition, style, animate } from '@angular/animations';
import { DomSanitizer, SafeHtml, SafeUrl } from '@angular/platform-browser';
import { GameCharacter } from '@udonarium/game-character';
import { DiceBot } from '@udonarium/dice-bot';
import { Config } from '@udonarium/config';
import { ObjectStore } from '@udonarium/core/synchronize-object/object-store';
import { EventSystem } from '@udonarium/core/system';
import { Network } from '@udonarium/core/system/network/network';
import { PeerContext } from '@udonarium/core/system/network/peer-context';

type DiceShape = 'd4' | 'd6' | 'd8' | 'd10' | 'd12' | 'd20' | 'd100';

interface SingleDiceResult {
  value: number;
  shape: DiceShape;
  discarded?: boolean;
}

interface SideRollData {
  characterIdentifier: string;
  characterName: string;
  characterImage: SafeUrl | string;
  formula: string;
  diceResults: SingleDiceResult[];
  rollResultText: string;
  total: number | null;
  isCritical: boolean;
  isFumble: boolean;
  isRolled: boolean;
  isRolling: boolean;
}

interface TargetResult {
  side: SideRollData;
  hit: boolean;
  resolved: boolean;
}

@Component({
  selector: 'contested-roll-cutin',
  templateUrl: './contested-roll-cutin.component.html',
  styleUrls: ['./contested-roll-cutin.component.css'],
  animations: [
    trigger('cutinAnimation', [
      transition(':enter', [
        style({ opacity: 0, transform: 'scale(0.8)' }),
        animate('0.4s cubic-bezier(0.16, 1, 0.3, 1)', style({ opacity: 1, transform: 'scale(1)' }))
      ]),
      transition(':leave', [
        animate('0.3s ease-in', style({ opacity: 0, transform: 'scale(0.9)' }))
      ])
    ])
  ]
})
export class ContestedRollCutinComponent implements OnInit, OnDestroy {
  active: boolean = false;
  attacker: SideRollData = null;
  targets: TargetResult[] = [];

  // チャットパレットピッカー
  activePaletteTarget: string | null = null;
  tieAdvantage: 'attacker' | 'defender' = 'attacker';
  damageFormula: string = '';
  damageTotal: number | null = null;
  armorField: string = '防護点';
  hpField: string = 'HP';
  defenseFormula: string = '1d20+{回避}';
  sessionId: string = ''; // 同期用セッションID

  get gameType(): string {
    return Config.instance.defaultDiceBot || 'DiceBot';
  }

  private listener: any = null;

  constructor(
    private ngZone: NgZone,
    private sanitizer: DomSanitizer
  ) {}

  ngOnInit() {
    this.listener = EventSystem.register(this)
      .on('CONTESTED_ROLL_SHOW', 600, event => {
        this.ngZone.run(() => this.handleShow(event.data));
      })
      .on('CONTESTED_ROLL_RESULT', 600, event => {
        this.ngZone.run(() => this.handleRollResult(event.data));
      })
      .on('CONTESTED_ROLL_DAMAGE', 600, event => {
        this.ngZone.run(() => this.handleDamageResult(event.data));
      })
      .on('CONTESTED_ROLL_CLOSE', 600, event => {
        this.ngZone.run(() => this.handleClose(event.data));
      });
  }

  ngOnDestroy() {
    if (this.listener) EventSystem.unregister(this.listener);
  }

  /**
   * 自分のpeerId/userId
   */
  private get myUserId(): string {
    return Network.instance?.peerContext?.userId || '';
  }

  /**
   * 指定キャラクタのオーナーかどうか
   */
  isOwner(characterIdentifier: string): boolean {
    const char = ObjectStore.instance.get<GameCharacter>(characterIdentifier);
    if (!char) return false;
    // コマのlocation名が自分のpeerIdと一致するか、またはownerプロパティで判定
    const owner = (char as any).owner || '';
    if (owner && owner === this.myUserId) return true;
    // 全員操作可能な場合はtrue（GM等）
    // TODO: より厳密な所有権判定が必要ならここを調整
    return true; // デフォルトは全員操作可能（テスト用）
  }

  /**
   * カットイン表示（ネットワークから受信）
   */
  private handleShow(data: any) {
    const attacker = data.attacker ? ObjectStore.instance.get<GameCharacter>(data.attacker) : null;
    const targets = (data.targets || [])
      .map((id: string) => ObjectStore.instance.get<GameCharacter>(id))
      .filter((c: any) => c);
    this.defenseFormula = data.defenseFormula || '1d20';
    this.sessionId = data.sessionId || '';
    this.show(attacker, data.attackerFormula || '1d20', targets, {
      tieAdvantage: data.tieAdvantage,
      damageFormula: data.damageFormula,
      armorField: data.armorField,
      hpField: data.hpField,
    });
  }

  /**
   * ロール結果受信（ネットワークから）
   */
  private handleRollResult(data: any) {
    if (data.sessionId !== this.sessionId) return;

    if (data.isAttacker) {
      if (this.attacker) {
        this.attacker.diceResults = data.diceResults || [];
        this.attacker.rollResultText = data.rollResultText || '';
        this.attacker.total = data.total;
        this.attacker.isCritical = data.isCritical || false;
        this.attacker.isFumble = data.isFumble || false;
        this.attacker.isRolled = true;
        this.attacker.isRolling = false;
      }
    } else {
      const t = this.targets.find(t => t.side.characterIdentifier === data.characterIdentifier);
      if (t) {
        t.side.diceResults = data.diceResults || [];
        t.side.rollResultText = data.rollResultText || '';
        t.side.total = data.total;
        t.side.isCritical = data.isCritical || false;
        t.side.isFumble = data.isFumble || false;
        t.side.isRolled = true;
        t.side.isRolling = false;
      }
    }
    this.checkResolve();
  }

  /**
   * ダメージ結果受信
   */
  private handleDamageResult(data: any) {
    if (data.sessionId !== this.sessionId) return;
    this.damageTotal = data.total;
  }

  /**
   * 閉じる受信
   */
  private handleClose(data: any) {
    if (data.sessionId !== this.sessionId) return;

    // 結果をbatch-damage-panelに送信
    const results = this.targets.map(t => ({
      identifier: t.side.characterIdentifier,
      total: t.side.total,
      hit: t.hit,
    }));

    EventSystem.trigger('CONTESTED_ROLL_RESOLVE', {
      attackerResult: this.attacker?.rollResultText || '',
      attackerTotal: this.attacker?.total,
      damageResult: this.damageFormula,
      damageTotal: this.damageTotal,
      results: results,
    });
    this.active = false;
  }

  /**
   * カットインを開始（ローカル）
   */
  show(attacker: GameCharacter, attackerFormula: string, targets: GameCharacter[], options: {
    tieAdvantage?: 'attacker' | 'defender';
    damageFormula?: string;
    armorField?: string;
    hpField?: string;
  } = {}) {
    this.tieAdvantage = options.tieAdvantage || 'attacker';
    this.damageFormula = options.damageFormula || '';
    this.armorField = options.armorField || '防護点';
    this.hpField = options.hpField || 'HP';
    this.damageTotal = null;

    this.attacker = {
      characterIdentifier: attacker?.identifier || '',
      characterName: attacker?.name || '???',
      characterImage: this.getCharacterImage(attacker),
      formula: attackerFormula,
      diceResults: [],
      rollResultText: '',
      total: null,
      isCritical: false,
      isFumble: false,
      isRolled: false,
      isRolling: false,
    };

    this.targets = targets.map(t => ({
      side: {
        characterIdentifier: t.identifier,
        characterName: t.name,
        characterImage: this.getCharacterImage(t),
        formula: this.defenseFormula,
        diceResults: [],
        rollResultText: '',
        total: null,
        isCritical: false,
        isFumble: false,
        isRolled: false,
        isRolling: false,
      },
      hit: false,
      resolved: false,
    }));

    this.active = true;
  }

  /**
   * 閉じる（ネットワーク送信）
   */
  close() {
    EventSystem.call('CONTESTED_ROLL_CLOSE', { sessionId: this.sessionId });
    // handleCloseで実際の処理を行う
  }

  private getCharacterImage(char: GameCharacter): SafeUrl | string {
    if (!char) return '';
    const img = char.imageFile?.url || '';
    if (!img) return '';
    const url = img.replace('./', '/');
    return this.sanitizer.bypassSecurityTrustUrl(url);
  }

  /**
   * 式を評価（トークン置換 → c()計算 → BCDice → 固定値 → 数式の順にフォールバック）
   */
  private async evaluateFormulaAsync(formula: string, character: GameCharacter | null): Promise<{
    total: number | null;
    resultText: string;
    diceResults: SingleDiceResult[];
    isCritical: boolean;
    isFumble: boolean;
  }> {
    // 1. {field} トークン置換
    let processed = formula;
    if (character) {
      processed = this.replaceFieldTokens(processed, character);
    }

    // 2. c(expr) 計算記法を事前評価
    processed = processed.replace(/c\(([^)]+)\)/gi, (match, expr) => {
      try {
        const val = new Function('return (' + expr + ')')();
        if (typeof val === 'number' && isFinite(val)) return String(val);
      } catch (e) {}
      return match;
    });

    // 2b. 純粋な括弧数式 (8+3) → 11
    processed = processed.replace(/\(([^()]*\d[^()]*)\)/g, (match, expr) => {
      if (/^[\d+\-*/.\s]+$/.test(expr)) {
        try {
          const val = new Function('return (' + expr + ')')();
          if (typeof val === 'number' && isFinite(val)) return String(val);
        } catch (e) {}
      }
      return match;
    });

    // 3. BCDiceで試す
    try {
      const gameSystem = await DiceBot.loadGameSystemAsync(this.gameType);
      const result = await DiceBot.diceRollAsync(processed, gameSystem);
      if (result && result.result) {
        const total = this.extractTotal(result.result);
        if (total !== null) {
          return {
            total,
            resultText: result.result,
            diceResults: this.parseDiceResults(result),
            isCritical: result.isCritical || false,
            isFumble: result.isFumble || false,
          };
        }
      }
    } catch (e) {
      console.debug('[ContestedRoll] BCDice fallback:', e);
    }

    // 4. コマンド部分を抽出（最初の空白より前）
    const commandPart = processed.trim().split(/\s+/)[0];

    // 5. 固定値
    const pureNumber = parseFloat(commandPart);
    if (!isNaN(pureNumber) && /^[-\d.]+$/.test(commandPart)) {
      return { total: pureNumber, resultText: String(pureNumber), diceResults: [], isCritical: false, isFumble: false };
    }

    // 6. 単純な数式 (8+5, 10-3)
    if (/^[\d+\-*/().\s]+$/.test(commandPart)) {
      try {
        const val = new Function('return (' + commandPart + ')')();
        if (typeof val === 'number' && isFinite(val)) {
          return { total: val, resultText: String(val), diceResults: [], isCritical: false, isFumble: false };
        }
      } catch (e) {}
    }

    // 7. 数値抽出フォールバック
    const numMatch = processed.match(/(-?\d+(?:\.\d+)?)/);
    if (numMatch) {
      return { total: parseFloat(numMatch[1]), resultText: processed.trim(), diceResults: [], isCritical: false, isFumble: false };
    }

    return { total: null, resultText: processed.trim(), diceResults: [], isCritical: false, isFumble: false };
  }

  /**
   * 攻撃側ロール
   */
  async rollAttacker() {
    if (!this.attacker || this.attacker.isRolled || this.attacker.isRolling) return;
    this.attacker.isRolling = true;

    try {
      const char = ObjectStore.instance.get<GameCharacter>(this.attacker.characterIdentifier);
      const r = await this.evaluateFormulaAsync(this.attacker.formula, char);

      EventSystem.call('CONTESTED_ROLL_RESULT', {
        sessionId: this.sessionId,
        isAttacker: true,
        diceResults: r.diceResults,
        rollResultText: r.resultText,
        total: r.total,
        isCritical: r.isCritical,
        isFumble: r.isFumble,
      });
    } catch (e) {
      console.error('rollAttacker error', e);
      this.attacker.isRolling = false;
    }
  }

  /**
   * 対象のロール
   */
  async rollTarget(target: TargetResult) {
    if (target.side.isRolled || target.side.isRolling) return;
    target.side.isRolling = true;

    try {
      const char = ObjectStore.instance.get<GameCharacter>(target.side.characterIdentifier);
      const r = await this.evaluateFormulaAsync(target.side.formula, char);

      EventSystem.call('CONTESTED_ROLL_RESULT', {
        sessionId: this.sessionId,
        isAttacker: false,
        characterIdentifier: target.side.characterIdentifier,
        diceResults: r.diceResults,
        rollResultText: r.resultText,
        total: r.total,
        isCritical: r.isCritical,
        isFumble: r.isFumble,
      });
    } catch (e) {
      console.error('rollTarget error', e);
      target.side.isRolling = false;
    }
  }

  /**
   * 全対象一括ロール（GM用）
   */
  async rollAllTargets() {
    for (const t of this.targets) {
      if (!t.side.isRolled) {
        await this.rollTarget(t);
        await new Promise(r => setTimeout(r, 300));
      }
    }
  }

  /**
   * ダメージロール
   */
  async rollDamage() {
    if (!this.damageFormula.trim()) return;
    try {
      const char = ObjectStore.instance.get<GameCharacter>(this.attacker?.characterIdentifier || '');
      const r = await this.evaluateFormulaAsync(this.damageFormula, char);

      EventSystem.call('CONTESTED_ROLL_DAMAGE', {
        sessionId: this.sessionId,
        total: r.total,
      });
    } catch (e) {
      console.error('rollDamage error', e);
    }
  }

  /**
   * 命中判定
   */
  private checkResolve() {
    if (!this.attacker?.isRolled) return;
    const allRolled = this.targets.length > 0 && this.targets.every(t => t.side.isRolled);
    if (!allRolled) return;

    for (const t of this.targets) {
      const atkTotal = this.attacker.total;
      const defTotal = t.side.total;
      if (atkTotal == null || defTotal == null) {
        t.hit = true;
      } else if (atkTotal > defTotal) {
        t.hit = true;
      } else if (atkTotal < defTotal) {
        t.hit = false;
      } else {
        t.hit = this.tieAdvantage === 'attacker';
      }
      t.resolved = true;
    }
    this.ngZone.run(() => {});
  }

  get hasUnrolledTargets(): boolean {
    return this.targets.length > 1 && this.targets.some(t => !t.side.isRolled);
  }

  get allResolved(): boolean {
    return this.attacker?.isRolled && this.targets.length > 0 && this.targets.every(t => t.resolved);
  }

  /**
   * 攻撃側のボタンを押せるか
   */
  get canRollAttacker(): boolean {
    if (!this.attacker || this.attacker.isRolled || this.attacker.isRolling) return false;
    return this.isOwner(this.attacker.characterIdentifier);
  }

  /**
   * 特定対象のボタンを押せるか
   */
  canRollTarget(characterIdentifier: string): boolean {
    const t = this.targets.find(t => t.side.characterIdentifier === characterIdentifier);
    if (!t || t.side.isRolled || t.side.isRolling) return false;
    return this.isOwner(characterIdentifier);
  }

  private replaceFieldTokens(formula: string, character: GameCharacter): string {
    if (!character || !formula) return formula;
    // 入れ子参照を解決するため最大32回ループ
    let limit = 32;
    let prev = '';
    let result = formula;
    while (prev !== result && limit-- > 0) {
      prev = result;
      result = result.replace(/\{([^}]+)\}/g, (match, fieldName) => {
        const name = fieldName.trim();
        // まず getStatusValue で数値として取得を試みる
        const numVal = character.getStatusValue(name, 'now');
        if (numVal != null && !isNaN(numVal)) return String(numVal);
        // 数値として取得できない場合、生の文字列値を取得（入れ子参照）
        const element = character.detailDataElement?.getFirstElementByName(name);
        if (element) {
          const rawVal = element.isNumberResource
            ? (element.currentValue != null ? element.currentValue + '' : element.value + '')
            : element.value + '';
          if (rawVal != null && rawVal !== '') return rawVal;
        }
        return match;
      });
    }
    return result;
  }

  private extractTotal(resultText: string): number | null {
    if (!resultText) return null;
    const patterns = [
      /(?:→|=|：)\s*[()（）]?(-?\d+)\s*[)（）]?/i,
      /(?:合計|Total|total)\s*[:：]?\s*(-?\d+)/i,
      /\b(-?\d+)\s*(?:ダメージ|damage)/i,
    ];
    for (const p of patterns) {
      const m = resultText.match(p);
      if (m) return parseInt(m[1]);
    }
    const nums = resultText.match(/-?\d+/g);
    if (nums && nums.length) return parseInt(nums[nums.length - 1]);
    return null;
  }

  private parseDiceResults(result: any): SingleDiceResult[] {
    if (!result?.detailedRands || !result.detailedRands.length) return [];
    return result.detailedRands.map((d: any) => ({
      value: d.value,
      shape: (`d${d.sides}` as DiceShape),
      discarded: false,
    }));
  }

  // ===== チャットパレットピッカー =====

  getPaletteLines(characterIdentifier: string): string[] {
    const char = ObjectStore.instance.get<GameCharacter>(characterIdentifier);
    if (!char || !char.chatPalette) return [];
    return char.chatPalette.getPalette().filter(line =>
      line.trim() && !line.startsWith('//') && !line.startsWith('◆')
    );
  }

  togglePalettePicker(target: string) {
    this.activePaletteTarget = this.activePaletteTarget === target ? null : target;
  }

  selectFromPalette(target: string, line: string) {
    if (target === 'attacker' && this.attacker) {
      this.attacker.formula = line;
    } else if (target === 'damage') {
      this.damageFormula = line;
    } else if (target.startsWith('defender:')) {
      const charId = target.substring('defender:'.length);
      const t = this.targets.find(t => t.side.characterIdentifier === charId);
      if (t) t.side.formula = line;
    }
    this.activePaletteTarget = null;
  }

  getDamagePaletteCharacterId(): string {
    return this.attacker?.characterIdentifier || '';
  }

  getDiceSvgSafe(shape: DiceShape): SafeHtml {
    const svgs: { [key: string]: string } = {
      'd20': '<svg viewBox="0 0 100 100"><polygon points="50,5 95,30 95,70 50,95 5,70 5,30" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
      'd12': '<svg viewBox="0 0 100 100"><polygon points="50,5 90,25 95,60 70,90 30,90 5,60 10,25" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
      'd10': '<svg viewBox="0 0 100 100"><polygon points="50,5 95,40 80,90 20,90 5,40" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
      'd8': '<svg viewBox="0 0 100 100"><polygon points="50,5 95,50 50,95 5,50" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
      'd6': '<svg viewBox="0 0 100 100"><rect x="15" y="15" width="70" height="70" rx="8" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
      'd4': '<svg viewBox="0 0 100 100"><polygon points="50,5 95,85 5,85" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
      'd100': '<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="42" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
    };
    return this.sanitizer.bypassSecurityTrustHtml(svgs[shape] || svgs['d6']);
  }
}
