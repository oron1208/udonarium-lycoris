import { Component, Input, NgZone, OnDestroy, OnInit } from '@angular/core';
import { EventSystem } from '@udonarium/core/system';
import { ObjectStore } from '@udonarium/core/synchronize-object/object-store';
import { GameCharacter } from '@udonarium/game-character';
import { GameTable } from '@udonarium/game-table';
import { ChatTabList } from '@udonarium/chat-tab-list';
import { ChatTab } from '@udonarium/chat-tab';
import { DiceBot } from '@udonarium/dice-bot';
import { Config } from '@udonarium/config';
import { ChatMessageService } from 'service/chat-message.service';
import { PresetSound, SoundEffect } from '@udonarium/sound-effect';

interface RollResult {
  name: string;
  input: string;
  resolved: string;
  result: string;
  isGmOnly: boolean;
  error: boolean;
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

    const trimmed = this.diceExpression.trim();
    const chatTab = this.chatTabs.find(t => t.identifier === this.selectedTabId) || this.chatTabs[0];
    if (!chatTab) return;

    const tables = ObjectStore.instance.getObjects<GameTable>(GameTable);
    const table = tables.find(t => t.selected) || tables[0];
    const enableExtended = table?.extendedDiceBotEnabled ?? false;

    // ダイスカットイン設定を記憶して一時OFF
    const originalDiceCutin = table?.diceCutinEnabled ?? false;
    if (table) {
      table.diceCutinEnabled = false;
      table.update();
    }

    const sendFrom = '一括ロール';

    for (const character of this.characters) {
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
        const charDice = character.chatPalette?.dicebot;
        const charGameType = (charDice && charDice !== 'DiceBot') ? charDice : Config.instance.defaultDiceBot;

        if (character.chatPalette) {
          resolved = character.chatPalette.evaluate(trimmed, character.rootDataElement, this.targetCharacter || character, enableExtended);
        }
        result.resolved = resolved;

        const gameSystem = await DiceBot.loadGameSystemAsync(charGameType);
        const rollResult = await DiceBot.diceRollAsync(resolved, gameSystem);

        if (rollResult && rollResult.result) {
          result.result = rollResult.result;
        } else {
          result.result = resolved;
        }

        // チャットにも送信
        this.chatMessageService.sendMessage(
          chatTab, resolved, gameSystem, character.name, null, 0, '#4B0082', null, result.isGmOnly
        );

      } catch (e) {
        result.error = true;
        result.result = `エラー: ${e.message || e}`;
      }

      this.ngZone.run(() => {
        this.results.push(result);
      });

      await new Promise(r => setTimeout(r, 300));
    }

    // ダイスカットイン設定を元に戻す
    if (table) {
      table.diceCutinEnabled = originalDiceCutin;
      table.update();
    }

    SoundEffect.play(PresetSound.diceRoll1);
    this.isRolling = false;
  }
}
