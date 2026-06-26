import { Component, OnInit, OnDestroy, NgZone } from '@angular/core';
import { ObjectStore } from '@udonarium/core/synchronize-object/object-store';
import { EventSystem } from '@udonarium/core/system';
import { GameCharacter } from '@udonarium/game-character';
import { DiceBot } from '@udonarium/dice-bot';
import { ChatMessageService } from 'service/chat-message.service';
import { PanelService } from 'service/panel.service';

interface TargetResult {
  character: GameCharacter;
  defenseValue: number | null;
  armorValue: number;
  currentHP: number;
  hit: boolean;
  damageRate: number; // 100, 50, 25, 0
  appliedDamage: number;
  newHP: number;
  applied: boolean;
}

@Component({
  selector: 'batch-damage-panel',
  templateUrl: './batch-damage-panel.component.html',
  styleUrls: ['./batch-damage-panel.component.css']
})
export class BatchDamagePanelComponent implements OnInit, OnDestroy {
  attacker: GameCharacter = null;

  // Input fields
  hitFormula: string = '1d20+5';
  damageFormula: string = '2d6+10';
  defenseField: string = '回避';
  armorField: string = '防護点';
  hpField: string = 'HP';
  defaultHitRate: number = 0;

  // Roll results
  hitRollResult: string = '';
  hitRollTotal: number | null = null;
  damageRollResult: string = '';
  damageRollTotal: number | null = null;
  hasRolled: boolean = false;
  isRolling: boolean = false;
  useContestedRoll: boolean = false; // 命中式に >= が含まれている場合

  // Target results
  targets: TargetResult[] = [];

  // Available field names for dropdowns
  availableFields: string[] = [];

  get availableFieldOptions(): string[] {
    return this.availableFields.length > 0 ? this.availableFields : ['HP', 'MP'];
  }

  private listener;

  constructor(
    private ngZone: NgZone,
    private chatMessageService: ChatMessageService,
    public panelService: PanelService
  ) {}

  ngOnInit() {
    this.panelService.title = '⚔️ 一括判定ダメージ';
    this.refreshTargets();
    this.collectFieldNames();

    this.listener = EventSystem.register(this)
      .on('UPDATE_GAME_OBJECT', 500, event => {
        const obj = ObjectStore.instance.get(event.data?.identifier);
        if (obj instanceof GameCharacter && obj.targeted) {
          this.ngZone.run(() => this.refreshTargets());
        }
      });
  }

  ngOnDestroy() {
    if (this.listener) EventSystem.unregister(this.listener);
  }

  private refreshTargets() {
    const locationName = this.attacker?.location?.name || 'table';
    const allChars = ObjectStore.instance.getObjects<GameCharacter>(GameCharacter);
    const targeted = allChars.filter(c => c.targeted && c.location.name === locationName && c.identifier !== this.attacker?.identifier);

    if (this.hasRolled) {
      // Merge new targets with existing results
      const existing = new Map(this.targets.map(t => [t.character.identifier, t]));
      this.targets = targeted.map(c => {
        const prev = existing.get(c.identifier);
        if (prev) {
          prev.character = c;
          prev.currentHP = c.getStatusValue(this.hpField, 'now') ?? 0;
          prev.newHP = prev.applied ? prev.currentHP : prev.currentHP;
          return prev;
        }
        return this.createTargetResult(c);
      });
    } else {
      this.targets = targeted.map(c => this.createTargetResult(c));
    }
  }

  private createTargetResult(c: GameCharacter): TargetResult {
    const def = c.getStatusValue(this.defenseField, 'now');
    const armor = c.getStatusValue(this.armorField, 'now') ?? 0;
    const hp = c.getStatusValue(this.hpField, 'now') ?? 0;
    return {
      character: c,
      defenseValue: def,
      armorValue: armor,
      currentHP: hp,
      hit: false,
      damageRate: 0,
      appliedDamage: 0,
      newHP: hp,
      applied: false
    };
  }

  private collectFieldNames() {
    const set = new Set<string>();
    const allChars = ObjectStore.instance.getObjects<GameCharacter>(GameCharacter);
    for (const c of allChars) {
      if (!c.detailDataElement) continue;
      this.collectFieldNamesRecursive(c.detailDataElement, set);
    }
    this.availableFields = Array.from(set).sort();
  }

  recalcDefenseValues() {
    for (const t of this.targets) {
      t.defenseValue = t.character.getStatusValue(this.defenseField, 'now');
      t.armorValue = t.character.getStatusValue(this.armorField, 'now') ?? 0;
      t.currentHP = t.character.getStatusValue(this.hpField, 'now') ?? 0;
      if (!t.applied) t.newHP = t.currentHP;
    }
    if (this.hasRolled) this.recalcResults();
  }

  get gameType(): string {
    return this.chatMessageService.gameType || 'DiceBot';
  }

  async executeRoll() {
    if (this.isRolling) return;
    if (!this.targets.length) {
      alert('対象コマがいません。ターゲットを指定してください。');
      return;
    }

    this.isRolling = true;
    this.hasRolled = false;

    try {
      const gameSystem = await DiceBot.loadGameSystemAsync(this.gameType);

      // 対抗ロール判定：命中式に >= が含まれているか
      this.useContestedRoll = this.hitFormula.includes('>=');

      // ダメージは1回だけロール
      if (this.damageFormula.trim()) {
        const dmgResult = await DiceBot.diceRollAsync(this.damageFormula, gameSystem);
        this.damageRollResult = dmgResult.result || '';
        this.damageRollTotal = this.extractTotal(dmgResult.result);
      }

      if (this.useContestedRoll) {
        // 対抗ロール方式：対象ごとに命中式を構築してBCDiceに判定させる
        this.hitRollResult = '';
        this.hitRollTotal = null;
        let summary = '';
        for (const t of this.targets) {
          const def = t.character.getStatusValue(this.defenseField, 'now');
          t.defenseValue = def;
          t.armorValue = t.character.getStatusValue(this.armorField, 'now') ?? 0;
          t.currentHP = t.character.getStatusValue(this.hpField, 'now') ?? 0;

          // 命中式の >= 以降を対象のステータス値で置換
          // 例: "1d20+{攻撃力}>=10" → 個別にロール
          let formula = this.hitFormula;
          if (def != null) {
            // >= の右側を対象の防御値に置換
            formula = formula.replace(/>=.*/, '>= ' + def);
          }
          // {フィールド名} を攻撃元のステータスで置換
          formula = this.replaceFieldTokens(formula, this.attacker);

          const hitResult = await DiceBot.diceRollAsync(formula, gameSystem);
          const total = this.extractTotal(hitResult.result);
          t.hit = hitResult.isSuccess || (total != null && def != null && total >= def);
          t.damageRate = t.hit ? 100 : this.defaultHitRate;
          t.applied = false;
          this.recalcTargetDamage(t);
          summary += `${t.character.name}: ${hitResult.result || ''} → ${t.hit ? '命中' : '回避'}\n`;
        }
        this.hitRollResult = summary;
      } else {
        // 1回ロール方式：達成値を1回だけ振って全対象と比較
        let hitTotal: number | null = null;
        if (this.hitFormula.trim()) {
          // {フィールド名} を攻撃元のステータスで置換
          const formula = this.replaceFieldTokens(this.hitFormula, this.attacker);
          const hitResult = await DiceBot.diceRollAsync(formula, gameSystem);
          this.hitRollResult = hitResult.result || '';
          hitTotal = this.extractTotal(hitResult.result);
          this.hitRollTotal = hitTotal;
        }

        for (const t of this.targets) {
          const def = t.character.getStatusValue(this.defenseField, 'now');
          t.defenseValue = def;
          t.armorValue = t.character.getStatusValue(this.armorField, 'now') ?? 0;
          t.currentHP = t.character.getStatusValue(this.hpField, 'now') ?? 0;

          if (hitTotal != null && def != null) {
            t.hit = hitTotal >= def;
          } else {
            t.hit = true;
          }
          t.damageRate = t.hit ? 100 : this.defaultHitRate;
          t.applied = false;
          this.recalcTargetDamage(t);
        }
      }

      this.hasRolled = true;
      this.sendResultToChat();
    } catch (e) {
      console.error('[BatchDamage] roll error', e);
      alert('ダイスロールでエラーが発生しました: ' + (e?.message || e));
    } finally {
      this.isRolling = false;
      this.ngZone.run(() => {});
    }
  }

  private replaceFieldTokens(formula: string, character: GameCharacter): string {
    if (!character || !formula) return formula;
    return formula.replace(/\{([^}]+)\}/g, (match, fieldName) => {
      const val = character.getStatusValue(fieldName.trim(), 'now');
      if (val != null) return String(val);
      // 攻撃元にない場合は、全対象から探す
      const allChars = ObjectStore.instance.getObjects<GameCharacter>(GameCharacter);
      for (const c of allChars) {
        const v = c.getStatusValue(fieldName.trim(), 'now');
        if (v != null) return String(v);
      }
      return match; // 見つからなければそのまま
    });
  }

  private extractTotal(resultText: string): number | null {
    if (!resultText) return null;
    // Try "→ 20" or "= 20" or "合計: 20"
    const patterns = [
      /(?:→|=|：)\s*[()（）]?(-?\d+)\s*[)（）]?/i,
      /(?:合計|Total|total)\s*[:：]?\s*(-?\d+)/i,
      /\b(-?\d+)\s*(?:ダメージ|damage)/i,
    ];
    for (const p of patterns) {
      const m = resultText.match(p);
      if (m) return parseInt(m[1]);
    }
    // Fallback: last number in the text
    const nums = resultText.match(/-?\d+/g);
    if (nums && nums.length) return parseInt(nums[nums.length - 1]);
    return null;
  }

  recalcResults() {
    if (!this.hasRolled) return;
    for (const t of this.targets) {
      if (t.applied) continue;
      this.recalcTargetDamage(t);
    }
  }

  private recalcTargetDamage(t: TargetResult) {
    const baseDmg = this.damageRollTotal ?? 0;
    const armoredDmg = Math.max(0, baseDmg - t.armorValue);
    t.appliedDamage = Math.floor(armoredDmg * t.damageRate / 100);
    t.newHP = Math.max(0, t.currentHP - t.appliedDamage);
  }

  onRateChange(t: TargetResult) {
    if (t.applied) return;
    this.recalcTargetDamage(t);
  }

  applyOne(t: TargetResult) {
    if (t.applied) return;
    if (t.appliedDamage > 0) {
      t.character.setStatusValue(this.hpField, 'now', t.newHP);
      t.character.update();
    }
    t.applied = true;
  }

  applyAll() {
    for (const t of this.targets) {
      if (t.applied) continue;
      if (t.appliedDamage > 0) {
        t.character.setStatusValue(this.hpField, 'now', t.newHP);
        t.character.update();
      }
      t.applied = true;
    }
  }

  private sendResultToChat() {
    const tabs = this.chatMessageService.chatTabs;
    const mainTab = tabs[0];
    if (!mainTab) return;

    let text = `【一括判定】攻撃元: ${this.attacker?.name || '???'}\n`;
    if (this.hitRollResult) text += `命中判定: ${this.hitFormula} → 達成値 ${this.hitRollTotal ?? '?'}\n`;
    if (this.damageRollResult) text += `ダメージ: ${this.damageFormula} → ${this.damageRollTotal ?? '?'}\n`;
    text += '────────\n';
    for (const t of this.targets) {
      const hitMark = t.hit ? '✅命中' : '❌回避';
      const defStr = t.defenseValue != null ? `[${this.defenseField}:${t.defenseValue}]` : '';
      text += `${t.character.name} ${defStr} ${hitMark}`;
      if (t.hit && this.damageRollTotal != null) {
        text += ` → ${this.damageRollTotal}-${t.armorValue}=${Math.max(0,this.damageRollTotal - t.armorValue)}dmg (HP:${t.currentHP}→${t.newHP})`;
      }
      text += '\n';
    }

    mainTab.addMessage({
      name: this.attacker?.name || '一括判定',
      text: text,
      tag: this.gameType,
      imageIdentifier: '',
      to: '',
    });
  }

  get noTargets(): boolean {
    return this.targets.length === 0;
  }

  maxZero(n: number): number {
    return Math.max(0, n);
  }

  private collectFieldNamesRecursive(el: any, set: Set<string>) {
    if (!el) return;
    const name = el.getAttribute && el.getAttribute('name');
    if (name) set.add(name);
    if (el.children) {
      for (const child of el.children) {
        this.collectFieldNamesRecursive(child, set);
      }
    }
  }
}
