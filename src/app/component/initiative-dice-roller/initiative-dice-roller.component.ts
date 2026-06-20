import { Component, NgZone, OnDestroy, OnInit } from '@angular/core';
import { EventSystem } from '@udonarium/core/system';
import { ObjectStore } from '@udonarium/core/synchronize-object/object-store';
import { GameCharacter } from '@udonarium/game-character';
import { InitiativeService } from 'service/initiative.service';
import { PanelService } from 'service/panel.service';
import { ChatMessageService } from 'service/chat-message.service';
import { ChatTabList } from '@udonarium/chat-tab-list';
import { DiceBot } from '@udonarium/dice-bot';
import { Config } from '@udonarium/config';
import { PresetSound, SoundEffect } from '@udonarium/sound-effect';

@Component({
  selector: 'initiative-dice-roller',
  templateUrl: './initiative-dice-roller.component.html',
  styleUrls: ['./initiative-dice-roller.component.css']
})
export class InitiativeDiceRollerComponent implements OnInit, OnDestroy {
  diceExpression: string = '';
  characters: GameCharacter[] = [];
  isRolling: boolean = false;

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
    private initiativeService: InitiativeService,
    private panelService: PanelService,
    private chatMessageService: ChatMessageService,
    private ngZone: NgZone
  ) {}

  ngOnInit() {}

  ngOnDestroy() {}

  get characterNames(): string {
    return this.characters.map(c => c.name).join(', ');
  }

  addDice(sides: number) {
    if (this.diceExpression.length > 0 && /\d$/.test(this.diceExpression)) {
      this.diceExpression += '+1d' + sides;
    } else {
      this.diceExpression += '1d' + sides;
    }
    SoundEffect.play(PresetSound.dicePick);
  }

  addText(text: string) {
    this.diceExpression += text;
  }

  clearExpression() {
    this.diceExpression = '';
  }

  backspace() {
    this.diceExpression = this.diceExpression.slice(0, -1);
  }

  async roll() {
    if (!this.diceExpression.trim() || this.characters.length === 0 || this.isRolling) return;
    this.isRolling = true;

    const visibleResults: string[] = [];
    const gmResults: string[] = [];

    for (const char of this.characters) {
      try {
        // チャパレのevaluateで変数解決
        let resolved = this.diceExpression;
        const charDice = char.chatPalette?.dicebot;
        const gameType = (charDice && charDice !== 'DiceBot') ? charDice : Config.instance.defaultDiceBot;

        if (char.chatPalette) {
          resolved = char.chatPalette.evaluate(this.diceExpression, char.rootDataElement, char, false);
        } else {
          resolved = this.initiativeService.resolveFormulaVariables(this.diceExpression, char);
        }

        // BCDiceで評価
        const gameSystem = await DiceBot.loadGameSystemAsync(gameType);
        const rollResult = await DiceBot.diceRollAsync(resolved, gameSystem);

        let value: number;
        let detail: string;
        if (rollResult && rollResult.result) {
          value = this.initiativeService.extractNumber(rollResult.result);
          detail = rollResult.result;
        } else {
          // フォールバック
          detail = this.initiativeService.evaluateDiceExpression(resolved);
          value = this.initiativeService.extractNumber(detail);
        }

        char.initiative = value;
        char.update();

        const isGmOnly = (char.visibility || 'public') === 'gmOnly';
        const line = `${char.name}: ${value} (${detail})`;
        if (isGmOnly) {
          gmResults.push(line);
        } else {
          visibleResults.push(line);
        }

        await new Promise(r => setTimeout(r, 200));
      } catch (e) {
        console.warn('Initiative dice roll error', char.name, e);
      }
    }

    SoundEffect.play(PresetSound.diceRoll1);
    this.initiativeService.resortCombatByInitiative();

    // チャットログに送信
    if (visibleResults.length > 0) {
      this.sendChat(`🎲 イニシアチブロール（${this.diceExpression}）`, visibleResults, false);
    }
    if (gmResults.length > 0) {
      this.sendChat(`🎲 イニシアチブロール（${this.diceExpression}）【GM限定】`, gmResults, true);
    }

    this.isRolling = false;
    // パネルを閉じる
    this.panelService.close();
  }

  cancel() {
    this.panelService.close();
  }

  private sendChat(title: string, lines: string[], secret: boolean) {
    const text = `${title}\n${lines.join(' / ')}`;
    const chatTabList = ObjectStore.instance.get<ChatTabList>('ChatTabList');
    const sysTab = chatTabList ? chatTabList.systemMessageTab : null;
    this.chatMessageService.sendSystemMessage(sysTab, text, '#4B0082', secret);
  }
}
