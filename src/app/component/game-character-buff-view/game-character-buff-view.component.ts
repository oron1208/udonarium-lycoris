import { Component, Input, OnInit, ChangeDetectorRef } from '@angular/core';

import { ModalService } from 'service/modal.service';
import { PanelService } from 'service/panel.service';
import { ChatMessageService } from 'service/chat-message.service';
import { InitiativeService } from 'service/initiative.service';

import { TabletopObject } from '@udonarium/tabletop-object';
import { GameCharacter, AutoBuffEntry, AutoBuffOperation, BuffExpireTiming } from '@udonarium/game-character';
import { DataElement } from '@udonarium/data-element';
import { mergeStatusMarkerDictionary, parseStatusMarkerIds, stringifyStatusMarkerIds, StatusMarkerDefinition } from '@udonarium/status-marker-dictionary';
import { TabletopService } from 'service/tabletop.service';
import { ChatTabList } from '@udonarium/chat-tab-list';
import { Config } from '@udonarium/config';
import { DiceBot } from '@udonarium/dice-bot';
import { ObjectStore } from '@udonarium/core/synchronize-object/object-store';

@Component({
  selector: 'game-character-buff-view',
  templateUrl: './game-character-buff-view.component.html',
  styleUrls: ['./game-character-buff-view.component.css']
})
export class GameCharacterBuffViewComponent implements OnInit {

//  @Input() title: string = '';

  @Input() character: TabletopObject = null;

  newBuffName: string = '新規効果';
  newBuffValue: string = '';
  newBuffRounds: number = 1;

  // 自動計算バフ用
  autoBuffName: string = '';
  autoBuffTargetStat: string = '';
  autoBuffOperation: AutoBuffOperation = 'add';
  autoBuffValue: number = 0;
  autoBuffRounds: number = 3;
  autoBuffPaletteCommand: string = '';
  autoBuffTargetGroup: string = 'リソース';
  autoBuffNewElementType: 'numberResource' | '' = 'numberResource';
  autoBuffGroups: string[] = ['リソース', '能力値', '技能', '情報'];
  autoBuffExpireTiming: BuffExpireTiming = 'round_end';
  autoBuffTriggerAsCurrent: boolean = true; // 現在手番キャラをトリガーとしてセット
  autoBuffTriggerId: string = ''; // 手動でトリガーキャラを選択する場合

  expireTimingOptions: { value: BuffExpireTiming; label: string; icon: string }[] = [
    { value: 'round_end', label: 'ラウンド終了時', icon: '🔄' },
    { value: 'turn_start', label: 'トリガーキャラ手番開始時', icon: '▶' },
    { value: 'turn_end', label: 'トリガーキャラ手番終了時', icon: '⏹' },
  ];

  get markerDictionary(): StatusMarkerDefinition[] { return mergeStatusMarkerDictionary(this.tabletopService.currentTable ? this.tabletopService.currentTable.statusMarkerDictionary : '[]'); }
  get gameCharacter(): GameCharacter { return this.character instanceof GameCharacter ? this.character : null; }
  get isAdvancedMode(): boolean { return this.tabletopService.currentTable?.roomMode === 'advanced'; }

  /** 編集可能なステータス名一覧（numberResource + 通常） */
  get availableStats(): string[] {
    if (!this.gameCharacter) return [];
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
    collect(this.gameCharacter.detailDataElement);
    return stats;
  }

  get autoBuffs(): AutoBuffEntry[] {
    return this.gameCharacter ? this.gameCharacter.getAutoBuffs() : [];
  }

  operationLabel(op: AutoBuffOperation): string {
    switch (op) {
      case 'add': return '加算';
      case 'append': return '最大値追加';
      case 'current': return '現状記録';
      case 'replace': return '置換';
      case 'create': return '新規要素';
      case 'palette': return 'チャパレ';
    }
  }

  expireTimingIcon(timing?: BuffExpireTiming): string {
    switch (timing) {
      case 'round_end': return '🔄';
      case 'turn_start': return '▶';
      case 'turn_end': return '⏹';
      default: return '🔄';
    }
  }

  expireTimingLabel(timing?: BuffExpireTiming): string {
    switch (timing) {
      case 'round_end': return 'ラウンド終了';
      case 'turn_start': return '手番開始';
      case 'turn_end': return '手番終了';
      default: return 'ラウンド終了';
    }
  }

  /** 現在の手番キャラのidentifierを取得 */
  get currentTurnCharId(): string {
    const order = this.initiativeService.getCombatOrder();
    const idx = this.initiativeService.currentTurnIndex;
    return order[idx] || '';
  }

  /** 現在の手番キャラ名を取得 */
  get currentTurnCharName(): string {
    const id = this.currentTurnCharId;
    if (!id) return '';
    const char = ObjectStore.instance.get<GameCharacter>(id);
    return char ? char.name : '';
  }

  /** トリガーキャラのidentifierを取得 */
  get effectiveTriggerIdentifier(): string {
    if (this.autoBuffTriggerAsCurrent) return this.currentTurnCharId;
    return this.autoBuffTriggerId;
  }

  /** トリガーキャラ名を取得 */
  get effectiveTriggerName(): string {
    if (this.autoBuffTriggerAsCurrent) return this.currentTurnCharName;
    const id = this.autoBuffTriggerId;
    if (!id) return '';
    const char = ObjectStore.instance.get<GameCharacter>(id);
    return char ? char.name : '';
  }

  /** 戦聞参加キャラ一覧を返す */
  get combatCharacters(): { id: string; name: string }[] {
    return this.initiativeService.getCombatEntries()
      .map(e => ({ id: e.identifier, name: e.name }));
  }

  /** チェックボックス切替時 */
  onTriggerAsCurrentChanged() {
    if (this.autoBuffTriggerAsCurrent) {
      this.autoBuffTriggerId = this.currentTurnCharId;
    } else if (!this.autoBuffTriggerId) {
      this.autoBuffTriggerId = this.currentTurnCharId;
    }
    this.changeDetector.markForCheck();
  }

  /** プルダウン手動選択時 */
  onTriggerManuallyChanged() {
    this.changeDetector.markForCheck();
  }

  addAutoBuff(event?: Event) {
    this.stopButtonEvent(event);
    if (!this.gameCharacter) return;
    if (this.autoBuffOperation !== 'palette' && !this.autoBuffTargetStat) return;
    if (this.autoBuffOperation === 'palette' && !this.autoBuffPaletteCommand) return;
    const name = (this.autoBuffName || '').trim() || (this.autoBuffOperation === 'create' ? this.autoBuffTargetStat : this.autoBuffOperation === 'palette' ? 'ダイス' : 'バフ');
    const targetStat = this.autoBuffOperation === 'palette' ? '' : this.autoBuffTargetStat;
    const newId = this.gameCharacter.applyAutoBuff(
      name,
      targetStat,
      this.autoBuffOperation,
      this.autoBuffValue,
      this.autoBuffRounds,
      this.autoBuffTargetGroup,
      this.autoBuffNewElementType,
      this.effectiveTriggerIdentifier,
      this.effectiveTriggerName,
      this.autoBuffExpireTiming
    );
    if (newId) {
      const buffs = this.gameCharacter.getAutoBuffs();
      const entry = buffs.find(b => b.id === newId);
      if (entry) {
        if (this.autoBuffPaletteCommand) entry.paletteCommand = this.autoBuffPaletteCommand;
        this.gameCharacter['saveAutoBuffs'](buffs);
      }
    }
    // 入力リセット
    this.autoBuffName = '';
    this.autoBuffValue = 0;
    this.autoBuffRounds = 3;
    this.autoBuffPaletteCommand = '';
    this.autoBuffExpireTiming = 'round_end';
  }

  removeAutoBuff(buffOrId: AutoBuffEntry | string, event?: Event) {
    this.stopButtonEvent(event);
    if (!this.gameCharacter) return;
    const id = typeof buffOrId === 'string' ? buffOrId : buffOrId?.id;
    if (!id) return;
    this.gameCharacter.removeAutoBuff(id);
  }

  rollBuffPalette(buff: AutoBuffEntry, event?: Event) {
    this.stopButtonEvent(event);
    if (!this.gameCharacter || !buff.paletteCommand) return;
    this.executeBuffPalette(this.gameCharacter, buff.paletteCommand);
  }

  private executeBuffPalette(character: GameCharacter, command: string) {
    const palette = character.chatPalette;
    const charDice = palette ? palette.dicebot : '';
    const gameType = (charDice && charDice !== 'DiceBot') ? charDice : Config.instance.defaultDiceBot;
    const sendFrom = character.identifier;
    const tachieNum = character.selectedTachieNum || 0;
    const messageColor = character.chatColorCode && character.chatColorCode.length ? character.chatColorCode[0] : '#000000';

    let evaluated = command;
    if (palette) {
      evaluated = palette.evaluate(command, character.rootDataElement, character, true);
    }
    const chatTab = ChatTabList.instance.children[0] as any;
    if (!chatTab) return;

    DiceBot.loadGameSystemAsync(gameType).then(gameSystem => {
      this.chatMessageService.sendMessage(chatTab, evaluated, gameSystem, sendFrom, '', tachieNum, messageColor);
    });
  }

  constructor(
    private panelService: PanelService,
    private modalService: ModalService,
    private tabletopService: TabletopService,
    private chatMessageService: ChatMessageService,
    private initiativeService: InitiativeService,
    private changeDetector: ChangeDetectorRef
  ) { }

  ngOnInit() {
    // トリガーキャラの初期値を現在の手番キャラに
    if (this.autoBuffTriggerAsCurrent && !this.autoBuffTriggerId) {
      this.autoBuffTriggerId = this.currentTurnCharId;
    }
  }

  addBuff() {
    if (!this.gameCharacter || !this.gameCharacter.buffDataElement) return;
    const root = this.findOrCreateBuffRoot();
    const name = (this.newBuffName || '').trim() || '新規効果';
    const rounds = Number.isFinite(Number(this.newBuffRounds)) ? Number(this.newBuffRounds) : 1;
    const buff = DataElement.create(name, rounds, { type: 'numberResource', currentValue: this.newBuffValue || '' });
    root.appendChild(buff);
    this.gameCharacter.update();
  }

  hasMarker(markerId: string): boolean {
    return !!this.gameCharacter && parseStatusMarkerIds(this.gameCharacter.statusMarkerIds).includes(markerId);
  }

  toggleMarker(markerId: string) {
    if (!this.gameCharacter) return;
    const markers = parseStatusMarkerIds(this.gameCharacter.statusMarkerIds);
    const index = markers.indexOf(markerId);
    if (0 <= index) {
      markers.splice(index, 1);
    } else {
      markers.push(markerId);
    }
    this.gameCharacter.statusMarkerIds = stringifyStatusMarkerIds(markers);
  }

  stopButtonEvent(event?: Event) {
    if (!event) return;
    event.preventDefault();
    event.stopPropagation();
  }

  private findOrCreateBuffRoot(): DataElement {
    let root = this.gameCharacter.buffDataElement.getFirstElementByName('バフ/デバフ');
    if (!root) {
      root = DataElement.create('バフ/デバフ', '');
      this.gameCharacter.buffDataElement.appendChild(root);
    }
    return root;
  }

}
