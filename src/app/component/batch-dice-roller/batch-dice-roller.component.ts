import { Component, Input, NgZone, OnDestroy, OnInit } from '@angular/core';
import { ObjectStore } from '@udonarium/core/synchronize-object/object-store';
import { GameCharacter } from '@udonarium/game-character';
import { GameTable } from '@udonarium/game-table';
import { ChatTabList } from '@udonarium/chat-tab-list';
import { ChatTab } from '@udonarium/chat-tab';
import { DiceBot } from '@udonarium/dice-bot';
import { Config } from '@udonarium/config';
import { ChatMessageTargetContext } from '@udonarium/chat-message';
import { ChatMessageService } from 'service/chat-message.service';
import { PresetSound, SoundEffect } from '@udonarium/sound-effect';
import GameSystemClass from 'bcdice/lib/game_system';
import Base from 'bcdice/lib/base';
import { Logger } from '../../class/core/system/util/logger';

interface RollResult {
  name: string;
  input: string;
  resolved: string;
  result: string;
  isGmOnly: boolean;
  error: boolean;
}

interface DiceSummary {
  expression: string;  // 元のダイス式 (例: 1d20)
  rolls: number[];     // 個別の出目 (例: [15])
  total: number;       // 合計 (例: 15)
  detail: string;      // 表示用 (例: "1d20 → 15")
}

@Component({
  selector: 'batch-dice-roller',
  templateUrl: './batch-dice-roller.component.html',
  styleUrls: ['./batch-dice-roller.component.css']
})
export class BatchDiceRollerComponent implements OnInit, OnDestroy {
  @Input() characters: GameCharacter[] = [];

  diceExpression: string = '';
  selectedTabId: string = '';
  isRolling: boolean = false;
  results: RollResult[] = [];
  singleDiceRoll: boolean = false; // ダイス1回のみモード
  diceSummary: DiceSummary | null = null; // ダイス1回のみの結果サマリー

  diceButtons = [
    { label: 'd4', sides: 4 },
    { label: 'd6', sides: 6 },
    { label: 'd8', sides: 8 },
    { label: 'd10', sides: 10 },
    { label: 'd12', sides: 12 },
    { label: 'd20', sides: 20 },
    { label: 'd100', sides: 100 },
  ];

  constructor(
    private chatMessageService: ChatMessageService,
    private ngZone: NgZone
  ) {}

  ngOnInit() {
    const tabs = this.chatTabs;
    if (tabs.length > 0) this.selectedTabId = tabs[0].identifier;
  }

  ngOnDestroy() {}

  get chatTabs(): ChatTab[] {
    return ChatTabList.instance.chatTabs;
  }

  get characterCount(): number {
    return this.characters.length;
  }

  get targetCharacter(): GameCharacter | null {
    if (!this.characters.length) return null;
    const locationName = this.characters[0]?.location?.name;
    const allChars = ObjectStore.instance.getObjects(GameCharacter);
    return allChars.find(c => c.targeted && c.location?.name === locationName) || null;
  }

  get targetName(): string {
    return this.targetCharacter?.name || '';
  }

  addText(text: string) {
    this.diceExpression += text;
  }

  addDice(sides: number) {
    this.diceExpression += `1d${sides}`;
  }

  clearExpression() {
    this.diceExpression = '';
    this.results = [];
  }

  async rollAll() {
    if (!this.diceExpression.trim() || this.isRolling) return;
    this.isRolling = true;
    this.results = [];
    this.diceSummary = null;

    const trimmed = this.diceExpression.trim();
    const chatTab = this.chatTabs.find(t => t.identifier === this.selectedTabId) || this.chatTabs[0];
    if (!chatTab) return;

    // :または&で始まる（スペース後）リソース編集コマンドか判定
    const isResourceEdit = /^\s*[sStT]?[:：&＆]/.test(' ' + trimmed) || /\s[tT]?[:：&＆]/.test(' ' + trimmed);

    // リソース編集 + ダイス1回のみモード: 先にダイスを1回だけ振っておく
    let fixedDiceValue: string | null = null; // ダイス部分の固定値（例: "15"）
    if (isResourceEdit && this.singleDiceRoll) {
      const colonPart = trimmed.replace(/^\s*[sStT]?[:：]/, '');
      const diceMatch = colonPart.match(/(\d+)d(\d+)/i);
      if (diceMatch) {
        const diceExpr = diceMatch[0];
        const gameType = Config.instance.defaultDiceBot;
        const gameSystem = await DiceBot.loadGameSystemAsync(gameType);
        const rollResult = await DiceBot.diceRollAsync(diceExpr, gameSystem);
        if (rollResult && rollResult.rands.length > 0) {
          const rolls = rollResult.rands.map(r => r[0]);
          const diceSum = rolls.reduce((a, b) => a + b, 0);
          fixedDiceValue = diceSum.toString();
          this.diceSummary = {
            expression: diceExpr,
            rolls: rolls,
            total: diceSum,
            detail: `${diceExpr} → ${rolls.join('+')}${rolls.length > 1 ? '=' + diceSum : ''} = ${diceSum}`
          };
        }
      }
    }

    const tables = ObjectStore.instance.getObjects<GameTable>(GameTable);
    const table = tables.find(t => t.selected) || tables[0];
    const enableExtended = table?.extendedDiceBotEnabled ?? false;

    // ダイスカットイン設定を記憶して一時OFF
    const originalDiceCutin = table?.diceCutinEnabled ?? false;
    if (table) {
      table.diceCutinEnabled = false;
      table.update();
    }

    let fixedRands: [number, number][] | null = null; // 1回目のダイス結果を保持

    for (let idx = 0; idx < this.characters.length; idx++) {
      const character = this.characters[idx];
      const isFirst = idx === 0;

      const result: RollResult = {
        name: character.name,
        input: trimmed,
        resolved: '',
        result: '',
        isGmOnly: (character.visibility || 'public') === 'gmOnly',
        error: false
      };

      try {
        let resolved = trimmed;
        // ダイス1回のみモード時はテーブル設定のダイスボットを優先
        const charDice = character.chatPalette?.dicebot;
        const charGameType = this.singleDiceRoll
          ? Config.instance.defaultDiceBot
          : ((charDice && charDice !== 'DiceBot') ? charDice : Config.instance.defaultDiceBot);

        if (character.chatPalette) {
          resolved = character.chatPalette.evaluate(trimmed, character.rootDataElement, this.targetCharacter || character, enableExtended);
        }
        result.resolved = resolved;

        const gameSystem = await DiceBot.loadGameSystemAsync(charGameType);

        // リソース編集コマンド(:HP+5 等)の場合は各コマにmessageTargetContextで送信
        if (isResourceEdit) {
          // リソース名部分を抽出（チャットパレット評価済みのresolvedから）
          const colonStripped = resolved.replace(/^\s*[sStT]?[:：]/, '');
          // ダイス1回のみモード: ダイス部分を固定値に置換
          let sendText: string;
          if (this.singleDiceRoll && fixedDiceValue) {
            sendText = colonStripped.replace(/(\d+)d(\d+)/gi, fixedDiceValue);
          } else {
            sendText = colonStripped;
          }
          const targetContext: ChatMessageTargetContext[] = [{
            text: `:${sendText}`,
            object: character
          }];
          // 結果表示をわかりやすく
          if (this.singleDiceRoll && fixedDiceValue && this.diceSummary) {
            result.result = `${sendText} (固定値${this.diceSummary.total}で更新)`;
          } else {
            result.result = `${sendText}`;
          }
          this.chatMessageService.sendMessage(
            chatTab, `:${sendText}`, gameSystem, character.identifier, null, 0, '#4B0082', targetContext, result.isGmOnly
          );
        } else if (this.singleDiceRoll && fixedRands && !isFirst) {
          const fixedResult = this.rollWithFixedDice(resolved, gameSystem, fixedRands);
          result.resolved = `${resolved} (ダイス固定: ${this.diceSummary?.detail || ''})`;
          if (fixedResult && fixedResult.result) {
            result.result = fixedResult.result;
          } else {
            result.result = resolved;
          }
          // 固定値の結果をチャットログに送信（元の式ではなく結果テキストを送る）
          if (fixedResult && fixedResult.result) {
            this.chatMessageService.sendSystemMessage(
              chatTab, `${character.name}: ${fixedResult.result} (ダイス固定)`, '#4B0082'
            );
          }
        } else {
          // 通常ロール
          const rollResult = await DiceBot.diceRollAsync(resolved, gameSystem);
          if (rollResult && rollResult.result) {
            result.result = rollResult.result;
          } else {
            result.result = resolved;
          }
          this.chatMessageService.sendMessage(
            chatTab, resolved, gameSystem, character.identifier, null, 0, '#4B0082', null, result.isGmOnly
          );

          // 1回目のダイス結果を保存
          if (this.singleDiceRoll && isFirst && rollResult && rollResult.rands.length > 0) {
            fixedRands = rollResult.rands;
            // ダイスサマリーを保存
            const rolls = rollResult.rands.map(r => r[0]);
            const diceSum = rolls.reduce((a, b) => a + b, 0);
            const diceExprMatch = resolved.match(/(\d+)d(\d+)/i);
            const diceExpr = diceExprMatch ? diceExprMatch[0] : resolved;
            this.diceSummary = {
              expression: diceExpr,
              rolls: rolls,
              total: diceSum,
              detail: rolls.length > 1
                ? `${diceExpr} → ${rolls.join('+')}=${diceSum}`
                : `${diceExpr} → ${diceSum}`
            };
          }
        }

      } catch (e) {
        result.error = true;
        result.result = `エラー: ${e.message || e}`;
      }

      this.ngZone.run(() => {
        this.results.push(result);
      });

      await new Promise(r => setTimeout(r, 300));
    }

    // ダイス1回のみモード: ダイス結果をチャットログにも送信
    if (this.singleDiceRoll && this.diceSummary) {
      const summaryText = `🎲 ダイス1回のみ: ${this.diceSummary.detail}`;
      this.chatMessageService.sendSystemMessage(chatTab, summaryText, '#553388');
    }

    // ダイスカットイン設定を元に戻す
    if (table) {
      table.diceCutinEnabled = originalDiceCutin;
      table.update();
    }

    SoundEffect.play(PresetSound.diceRoll1);
    this.isRolling = false;
  }

  /**
   * BCDiceのmockRandomizerを使って固定ダイス値でロールする
   * AR等のゲームシステム固有コマンドにも対応
   */
  private rollWithFixedDice(command: string, gameSystem: GameSystemClass, rands: [number, number][]): { result: string; isSecret: boolean } | null {
    try {
      const instance: Base = new (gameSystem as any)(command);
      const randomizer = (instance as any).randomizer;
      if (!randomizer) return null;

      // randomizerの$randomをスタブ化
      let callIdx = 0;
      const origRandom = randomizer.$random;
      randomizer.$random = function() {
        if (callIdx < rands.length) {
          return rands[callIdx++][0];
        }
        return 1; // フォールバック
      };

      const evalResult = instance.eval();

      // スタブを戻す
      randomizer.$random = origRandom;

      if (evalResult) {
        const resultText = `${gameSystem.ID} : ${evalResult.text}`.replace(/\n?(#\d+)\n/ig, '$1 ');
        return { result: resultText, isSecret: evalResult.secret };
      }
    } catch (e) {
      Logger.error('rollWithFixedDice error', e);
    }
    return null;
  }
}
