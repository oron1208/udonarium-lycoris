import { Component } from '@angular/core';
import { Logger } from '../../class/core/system/util/logger';

import { FileArchiver } from '@udonarium/core/file-storage/file-archiver';
import { ImageStorage } from '@udonarium/core/file-storage/image-storage';
import { ObjectStore } from '@udonarium/core/synchronize-object/object-store';
import { GameCharacter } from '@udonarium/game-character';
import { ReloadCheck } from '@udonarium/reload-check';
import { EventSystem, Network } from '@udonarium/core/system';

import { TextViewComponent } from 'component/text-view/text-view.component';
import { ChatMessageService } from 'service/chat-message.service';
import { ModalService } from 'service/modal.service';
import { PanelService } from 'service/panel.service';

@Component({
  selector: 'data-import-menu',
  templateUrl: './data-import-menu.component.html',
  styleUrls: ['./data-import-menu.component.css']
})
export class DataImportMenuComponent {
  get reloadCheck(): ReloadCheck { return ObjectStore.instance.get<ReloadCheck>('ReloadCheck'); }

  constructor(
    private modalService: ModalService,
    private panelService: PanelService,
    private chatMessageService: ChatMessageService
  ) { }

  ngOnInit() {
    Promise.resolve().then(() => this.panelService.title = 'データ読込');
  }

  handleFileSelect(event: Event) {
    const input = <HTMLInputElement>event.target;
    const files = input.files;

    this.reloadCheck.reloadCheckStart(Network.peerContext.roomName != '');

    if (files && files.length) FileArchiver.instance.load(files);
    input.value = '';
  }

  async importIacharaFromClipboard() {
    if (!navigator.clipboard || !navigator.clipboard.readText) {
      await this.openMessage('いあきゃらコマ読込', 'このブラウザではテキストクリップボードを読めません。HTTPS接続で開いてから試してください。');
      return;
    }

    let clipboardText = '';
    try {
      clipboardText = await navigator.clipboard.readText();
    } catch (error) {
      Logger.warn('Clipboard read failed', error);
      await this.openMessage('いあきゃらコマ読込', 'クリップボードを読めませんでした。ブラウザの許可設定を確認してください。');
      return;
    }

    const iadata = this.parseIacharaCharacterData(clipboardText);
    if (!iadata) {
      await this.openMessage('いあきゃらコマ読込', 'クリップボードに、いあきゃらのココフォリア用コマデータが見つかりませんでした。');
      return;
    }

    await this.openMessage('いあきゃらコマ読込', 'コマデータを確認しました。取り込みます。');

    const characterData = iadata.data;
    const imageIdentifier = characterData.iconUrl ? ImageStorage.instance.add(characterData.iconUrl).identifier : '';
    const character = GameCharacter.createFromIachara(iadata, imageIdentifier);
    character.location.x = 0;
    character.location.y = 0;
    character.posZ = 0;
    character.update();

    this.chatMessageService.sendSystemMessageLastSendCharactor(`${character.name} をいあきゃらコマデータから取り込みました。`);

    const hotbarSlots = GameCharacter.buildIacharaHotbarSlots(characterData);
    if (hotbarSlots.length > 0 && window.confirm(`CoCでよく使う判定をホットバーに割り振りますか？\n${hotbarSlots.length}個の候補を登録できます。`)) {
      EventSystem.trigger('IACHARA_HOTBAR_IMPORT', {
        characterIdentifier: character.identifier,
        characterName: character.name,
        slots: hotbarSlots
      });
      this.chatMessageService.sendSystemMessageLastSendCharactor(`${character.name} のCoC判定をホットバーに割り振りました。`);
    }
  }

  private parseIacharaCharacterData(source: string): any {
    if (!source) return null;
    let text = source.trim();
    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    if (firstBrace < 0 || lastBrace < firstBrace) return null;
    text = text.substring(firstBrace, lastBrace + 1);

    let parsed: any = null;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      Logger.warn('Iachara JSON parse failed', error);
      return null;
    }

    if (!parsed || parsed.kind !== 'character' || !parsed.data) return null;
    if (!parsed.data.name || (!Array.isArray(parsed.data.status) && !Array.isArray(parsed.data.params) && !parsed.data.commands)) return null;
    return parsed;
  }

  private async openMessage(title: string, text: string): Promise<void> {
    await this.modalService.open(TextViewComponent, { title: title, text: text });
  }
}
