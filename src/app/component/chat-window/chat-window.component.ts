import { AfterViewInit, Component, OnDestroy, OnInit, ViewChild } from '@angular/core';
import GameSystemClass from 'bcdice/lib/game_system';
import { ChatMessage, ChatMessageTargetContext} from '@udonarium/chat-message';
import { ChatTab } from '@udonarium/chat-tab';
import { DiceBot } from '@udonarium/dice-bot';
import { GameCharacter } from '@udonarium/game-character';
import { ObjectStore } from '@udonarium/core/synchronize-object/object-store';
import { EventSystem } from '@udonarium/core/system';
import { PeerCursor } from '@udonarium/peer-cursor';
import { ChatTabSettingComponent } from 'component/chat-tab-setting/chat-tab-setting.component';
import { ChatTabComponent } from 'component/chat-tab/chat-tab.component';
import { ChatMessageService } from 'service/chat-message.service';
import { PanelOption, PanelService } from 'service/panel.service';
import { PointerDeviceService } from 'service/pointer-device.service';
import { Logger } from '../../class/core/system/util/logger';

import { DiceTableSettingComponent } from 'component/dice-table-setting/dice-table-setting.component';
import { ImageFile } from '@udonarium/core/file-storage/image-file';
import { ImageStorage } from '@udonarium/core/file-storage/image-storage';

import { VoteMenuComponent } from 'component/vote-menu/vote-menu.component';
import { AlarmMenuComponent } from 'component/alarm-menu/alarm-menu.component';
import { PopupBridgeService } from 'service/popup-bridge.service';


@Component({
  selector: 'chat-window',
  templateUrl: './chat-window.component.html',
  styleUrls: ['./chat-window.component.css']
})
export class ChatWindowComponent implements OnInit, OnDestroy, AfterViewInit {
  sendFrom: string = 'Guest';

  get gameType(): string { return !this.chatMessageService.gameType ? 'DiceBot' : this.chatMessageService.gameType; }
  set gameType(gameType: string) { this.chatMessageService.gameType = gameType; }

  private _chatTabidentifier: string = '';
  get chatTabidentifier(): string { return this._chatTabidentifier; }
  set chatTabidentifier(chatTabidentifier: string) {
    let hasChanged: boolean = this._chatTabidentifier !== chatTabidentifier;
    this._chatTabidentifier = chatTabidentifier;
    if (hasChanged) delete this.notifyTabs[chatTabidentifier];
    this.updatePanelTitle();
    if (hasChanged) {
      this.scrollToBottom(true);
    }
  }

  chatTabSwitchRelative(direction: number) {
    let chatTabs = this.chatMessageService.chatTabs;
    let index = chatTabs.findIndex((elm) => elm.identifier == this.chatTabidentifier);
    if (index < 0) { return; }

    let nextIndex: number;
    if (index == chatTabs.length - 1 && direction == 1) {
      nextIndex = 0;
    } else if (index == 0 && direction == -1) {
      nextIndex = chatTabs.length - 1;
    } else {
      nextIndex = index + direction;
    }
    this.chatTabidentifier = chatTabs[nextIndex].identifier;
  }

  private testcount:number = 0;

  get chatTab(): ChatTab { return ObjectStore.instance.get<ChatTab>(this.chatTabidentifier); }
  isAutoScroll: boolean = true;
  scrollToBottomTimer: NodeJS.Timer = null;

  testadd(){
    this.chatTab.count ++;
  }
  get testmess(): string[] { 
   return this.chatTab.imageIdentifier;
  } 

  constructor(
    public chatMessageService: ChatMessageService,
    private panelService: PanelService,
    private pointerDeviceService: PointerDeviceService,
    private popupBridge: PopupBridgeService
  ) { }

  ngOnInit() {
    this.sendFrom = PeerCursor.myCursor.identifier;
    this.loadAppearance();
    this._chatTabidentifier = 0 < this.chatMessageService.chatTabs.length ? this.chatMessageService.chatTabs[0].identifier : '';

    EventSystem.register(this)
      .on('MESSAGE_ADDED', event => {
        this.maybePushPopupAppend(event.data.tabIdentifier, event.data.messageIdentifier);
        this.handleNotify(event.data.tabIdentifier, event.data.messageIdentifier);
        if (event.data.tabIdentifier !== this.chatTabidentifier) return;
        let message = ObjectStore.instance.get<ChatMessage>(event.data.messageIdentifier);
        if (message && message.isSendFromSelf) {
          this.isAutoScroll = true;
        } else {
          this.checkAutoScroll();
        }
        if (this.isAutoScroll && this.chatTab) this.chatTab.markForRead();
      });
    this.popupOff = this.popupBridge.channel(ChatWindowComponent.POPUP_OWNER).onMessage(message => this.handlePopupMessage(message));
    this.popupTimer = setInterval(() => {
      if (this.isServing() && this.isSubLive()) this.pushPopupState();
    }, 10000);
    Promise.resolve().then(() => this.updatePanelTitle());
  }

  ngAfterViewInit() {
    queueMicrotask(() => this.scrollToBottom(true));
  }

  // ===== 発言通知（タブ単位・デフォルトOFF） =====
  private static readonly SOUND_KEY = 'lycoris.chat-sound.v1';
  private audioCtx: AudioContext | null = null;
  notifyTabs: { [tabId: string]: boolean } = {};

  isSoundEnabled(tabId: string): boolean {
    try {
      const map = JSON.parse(localStorage.getItem(ChatWindowComponent.SOUND_KEY) || '{}');
      return !!map[tabId];
    } catch { return false; }
  }

  private ensureAudioContext(): AudioContext {
    if (!this.audioCtx) this.audioCtx = new AudioContext();
    if (this.audioCtx.state === 'suspended') this.audioCtx.resume();
    return this.audioCtx;
  }

  private playNotifySound() {
    try {
      const ctx = this.ensureAudioContext();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(1320, ctx.currentTime + 0.08);
      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.22, ctx.currentTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.4);
    } catch { }
  }

  private handleNotify(tabIdentifier: string, messageIdentifier: string) {
    if (!this.isSoundEnabled(tabIdentifier)) return;
    const message = ObjectStore.instance.get<ChatMessage>(messageIdentifier);
    if (!message || message.isSystem || message.isSendFromSelf) return;
    this.playNotifySound();
    this.notifyTabs[tabIdentifier] = true;
  }

  // ===== チャットログ検索 =====
  @ViewChild(ChatTabComponent) chatTabComponent?: ChatTabComponent;
  searchOpen = false;
  searchQuery = '';

  get searchResults(): { msgIdentifier: string, tabIdentifier: string, tabName: string, name: string, text: string, timestamp: number, hasImage: boolean }[] {
    const query = this.searchQuery.trim().toLowerCase();
    if (!query) return [];
    const results: { msgIdentifier: string, tabIdentifier: string, tabName: string, name: string, text: string, timestamp: number, hasImage: boolean }[] = [];
    for (const tab of this.chatMessageService.chatTabs) {
      for (const msg of tab.chatMessages) {
        if (!msg.isDisplayable) continue; // 表示されないメッセージ（Whisper等）はDOMに無いので検索結果に出さない
        if (msg.isSecret && !msg.isSendFromSelf) continue; // 他人のシークレットは検索結果に出さない
        const text = (msg.text || '').toLowerCase();
        const name = (msg.name || '').toLowerCase();
        if (text.includes(query) || name.includes(query)) {
          results.push({
            msgIdentifier: msg.identifier,
            tabIdentifier: tab.identifier,
            tabName: tab.name,
            name: msg.name,
            text: msg.text,
            timestamp: msg.timestamp,
            hasImage: !!(msg.imageIdentifier && 0 < msg.imageIdentifier.length),
          });
        }
      }
    }
    results.sort((a, b) => b.timestamp - a.timestamp);
    return results.slice(0, 50);
  }

  jumpToTab(tabIdentifier: string) {
    // シングルクリック: タブだけ切り替える（検索パネルは開いたまま）
    this.chatTabidentifier = tabIdentifier;
  }

  /** 検索ヒットをダブルクリックした時：そのタブへ移動してメッセージの場所までスクロールする */
  jumpToMessage(tabIdentifier: string, msgIdentifier: string) {
    this.chatTabidentifier = tabIdentifier;
    this.searchOpen = false; // ジャンプしたらパネルを閉じてチャットを見せる
    const tryScroll = (remain: number) => {
      // 仮想スクロール: 対象メッセージを含む範囲を描画してから要素を探す
      if (this.chatTabComponent) this.chatTabComponent.jumpToMessageByIdentifier(msgIdentifier);
      const el = document.querySelector(`chat-message[data-message-id="${msgIdentifier}"]`) as HTMLElement;
      if (!el) {
        // タブ切替直後のレンダリング待ち。要素が見つかるまで少しリトライする
        if (0 < remain) setTimeout(() => tryScroll(remain - 1), 120);
        return;
      }
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.style.transition = 'background-color 0.4s';
      el.style.backgroundColor = 'rgba(255, 214, 79, 0.5)';
      setTimeout(() => { el.style.backgroundColor = ''; }, 2400);
    };
    setTimeout(() => tryScroll(8), 150);
  }

  // ===== 外観設定（自分のブラウザだけに適用） =====
  static readonly FONT_KEY = 'lycoris.chat-font-size.v1';
  static readonly BG_KEY = 'lycoris.chat-bg.v1';
  chatFontSize = 14;
  chatBgColor = '';
  showAppearance = false;

  loadAppearance() {
    try {
      const size = Number(localStorage.getItem(ChatWindowComponent.FONT_KEY));
      if (size >= 10 && size <= 22) this.chatFontSize = size;
      this.chatBgColor = localStorage.getItem(ChatWindowComponent.BG_KEY) || '';
    } catch { }
    this.applyAppearance(false);
  }

  applyAppearance(save: boolean = true) {
    const root = document.documentElement;
    root.style.setProperty('--lycoris-chat-font-size', this.chatFontSize + 'px');
    if (this.chatBgColor) root.style.setProperty('--lycoris-chat-bg', this.chatBgColor);
    else root.style.removeProperty('--lycoris-chat-bg');
    if (save) {
      try {
        localStorage.setItem(ChatWindowComponent.FONT_KEY, String(this.chatFontSize));
        localStorage.setItem(ChatWindowComponent.BG_KEY, this.chatBgColor);
      } catch { }
    }
  }

  changeFontSize(delta: number) {
    this.chatFontSize = Math.min(22, Math.max(10, this.chatFontSize + delta));
    this.applyAppearance();
  }

  resetAppearance() {
    this.chatFontSize = 14;
    this.chatBgColor = '';
    this.applyAppearance();
  }

  ngOnDestroy() {
    EventSystem.unregister(this);
    if (this.popupTimer) clearInterval(this.popupTimer);
    if (this.popupOff) this.popupOff();
    if (this.popupToken) {
      this.popupBridge.channel(ChatWindowComponent.POPUP_OWNER).post({ type: 'owner-bye' });
      this.popupBridge.releaseServe(ChatWindowComponent.POPUP_OWNER, this.popupToken);
      this.popupToken = null;
    }
  }

  /* ═══════════ 別ウィンドウ（チャットポップアウト）ブリッジ ═══════════ */

  private static readonly POPUP_OWNER = 'chat:main';

  private popupOff: () => void = null;
  private popupTimer: any = null;
  private popupToken: object = null;
  private subLastSeen = 0;

  private isSubLive(): boolean { return Date.now() - this.subLastSeen < 8000; }
  private isServing(): boolean { return this.popupBridge.isServing(ChatWindowComponent.POPUP_OWNER, this.popupToken); }

  openChatWindowPopup() {
    this.popupToken = this.popupBridge.claimServe(ChatWindowComponent.POPUP_OWNER);
    this.popupBridge.openPopup('chat', ChatWindowComponent.POPUP_OWNER, { width: 560, height: 820 });
    this.compactHostPanel();
  }

  /** ポップアウト中はメイン画面のこのパネルを最小化して左下へ畳んでおく。 */
  private compactHostPanel() {
    const ref = (this.panelService as any).panelComponentRef;
    const panel: any = ref ? ref.instance : null;
    if (!panel || typeof panel.toggleMinimize !== 'function') return;
    try {
      if (!panel.isMinimized) panel.toggleMinimize();
      const element: HTMLElement = panel.draggablePanel ? panel.draggablePanel.nativeElement : null;
      // 最小化直後はレイアウト反映前のためタイトルバーの高さで計算する
      const titleBar: HTMLElement = panel.titleBar ? panel.titleBar.nativeElement : null;
      const height = titleBar ? titleBar.offsetHeight : 48;
      panel.left = 12;
      panel.top = Math.max(12, window.innerHeight - height - 12);
      if (element) {
        element.style.left = panel.left + 'px';
        element.style.top = panel.top + 'px';
      }
    } catch (_) { /* パネル操作に失敗してもポップアウト自体は継続 */ }
  }

  private handlePopupMessage(message: any) {
    if (!this.isServing()) return;
    switch (message.type) {
      case 'ready':
        this.subLastSeen = Date.now();
        this.pushPopupState();
        break;
      case 'bye':
        this.subLastSeen = 0;
        break;
      case 'select-tab':
        if (typeof message.identifier === 'string'
          && this.chatMessageService.chatTabs.some(tab => tab.identifier === message.identifier)) {
          this.chatTabidentifier = message.identifier;
        }
        this.pushPopupState();
        break;
      case 'select-sendfrom':
        if (typeof message.identifier === 'string') this.sendFrom = message.identifier;
        break;
      case 'send-chat': {
        const text = typeof message.text === 'string' ? message.text : '';
        if (!text.trim()) break;
        const sendFrom = typeof message.sendFrom === 'string' && message.sendFrom ? message.sendFrom : this.sendFrom;
        DiceBot.loadGameSystemAsync(this.gameType).then(gameSystem => {
          this.sendChat({ text, gameSystem, sendFrom, sendTo: '', tachieNum: null, messColor: '' });
        });
        break;
      }
    }
  }

  private serializeEntry(m: ChatMessage) {
    const image = m.imageIdentifier ? ImageStorage.instance.get(m.imageIdentifier) : null;
    return {
      name: m.name || '',
      text: String(m.text ?? ''),
      timestamp: m.timestamp || 0,
      messColor: m.messColor || '',
      isSystem: !!m.isSystem,
      isDicebot: !!m.isDicebot,
      isSecret: !!m.isSecret,
      secretVisible: !m.isDirect || m.isRelatedToMe,
      isMine: !!m.isSendFromSelf,
      imageUrl: image && image.url ? image.url : ''
    };
  }

  private pushPopupState() {
    const characters = ObjectStore.instance.getObjects<GameCharacter>(GameCharacter)
      .map(character => ({ identifier: character.identifier, name: character.name }));
    const cursor = PeerCursor.myCursor;
    this.popupBridge.channel(ChatWindowComponent.POPUP_OWNER).post({
      type: 'state',
      state: {
        mode: 'chat',
        title: this.chatTab ? this.chatTab.name : 'チャット',
        tabs: this.chatMessageService.chatTabs.map(tab => ({ id: tab.identifier, name: tab.name })),
        currentTab: this.chatTabidentifier,
        characters,
        sendFrom: this.sendFrom,
        sendFromName: cursor ? cursor.name : '自分',
        gameType: this.gameType,
        messages: this.popupMessages()
      }
    });
  }

  private popupMessages(): any[] {
    const tab = this.chatTab;
    if (!tab) return [];
    return (tab.chatMessages || []).filter(m => m.isDisplayable).slice(-250).map(m => this.serializeEntry(m));
  }

  private maybePushPopupAppend(tabIdentifier: string, messageIdentifier: string) {
    if (!this.isServing() || !this.isSubLive()) return;
    if (tabIdentifier !== this.chatTabidentifier) return;
    const message = ObjectStore.instance.get<ChatMessage>(messageIdentifier);
    if (!message || !message.isDisplayable) return;
    this.popupBridge.channel(ChatWindowComponent.POPUP_OWNER).post({
      type: 'chat-append',
      tab: tabIdentifier,
      entries: [this.serializeEntry(message)]
    });
  }

  // @TODO やり方はもう少し考えた方がいいい
  scrollToBottom(isForce: boolean = false) {
    if (isForce) this.isAutoScroll = true;
    if (!this.isAutoScroll) return;
    let event = new CustomEvent('scrolltobottom', {});
    this.panelService.scrollablePanel.dispatchEvent(event);
    if (this.scrollToBottomTimer != null) return;
    this.scrollToBottomTimer = setTimeout(() => {
      if (this.chatTab) this.chatTab.markForRead();
      this.scrollToBottomTimer = null;
      this.isAutoScroll = false;
      if (this.panelService.scrollablePanel) {
        this.panelService.scrollablePanel.scrollTop = this.panelService.scrollablePanel.scrollHeight;
      }
    }, 0);
  }

  // @TODO
  checkAutoScroll() {
    if (!this.panelService.scrollablePanel) return;
    let top = this.panelService.scrollablePanel.scrollHeight - this.panelService.scrollablePanel.clientHeight;
    if (top - 150 <= this.panelService.scrollablePanel.scrollTop) {
      this.isAutoScroll = true;
    } else {
      this.isAutoScroll = false;
    }
  }

  updatePanelTitle() {
    if (this.chatTab) {
      this.panelService.title = 'チャットウィンドウ - ' + this.chatTab.name;
      this.panelService.chatTab = this.chatTab;
    } else {
      this.panelService.title = 'チャットウィンドウ';
      this.panelService.chatTab = null ;
    }
  }

  onSelectedTab(identifier: string) {
    this.updatePanelTitle();
  }

  showTabSetting() {
    let coordinate = this.pointerDeviceService.pointers[0];
    let option: PanelOption = { left: coordinate.x - 250, top: coordinate.y - 175, width: 500, height: 380 };
    let component = this.panelService.open<ChatTabSettingComponent>(ChatTabSettingComponent, option);
    component.selectedTab = this.chatTab;
  }

  showDiceTableSetting() {
    let coordinate = this.pointerDeviceService.pointers[0];
    let option: PanelOption = { left: coordinate.x + 50, top: coordinate.y - 450, width: 650, height: 400 };
    let component = this.panelService.open<DiceTableSettingComponent>(DiceTableSettingComponent, option);
  }

  showVoteMenu() {
    let coordinate = this.pointerDeviceService.pointers[0];
    let option: PanelOption = { left: coordinate.x + 50, top: coordinate.y - 450, width: 650, height: 400 };
    let component = this.panelService.open<VoteMenuComponent>(VoteMenuComponent, option);
  }

  showAlarmMenu() {
    let coordinate = this.pointerDeviceService.pointers[0];
    let option: PanelOption = { left: coordinate.x + 50, top: coordinate.y - 450, width: 650, height: 400 };
    let component = this.panelService.open<AlarmMenuComponent>(AlarmMenuComponent, option);
  }

  checkTargetCharactor(text: string): boolean{
    let istarget = false;
    if( text.match(/^[sSｓＳ]?[tTｔＴ][:：]([^:：]+)/g) ){
      istarget = true;
    }
    if( text.match(/\s[sSｓＳ]?[tTｔＴ][:：]([^:：]+)/g) ){
      istarget = true;
    }
    if( text.match(/^[tTｔＴ][&＆]([^&＆]+)/g) ){
      istarget = true;
    }
    if( text.match(/\s[tTｔＴ][&＆]([^&＆]+)/g) ){
      istarget = true;
    }
    return istarget;
  }

  private targeted(gameCharacter: GameCharacter): boolean {
    // 卓上のコマ または キャラクターグループ内の部位(location.name='parts')を対象に含める。
    if (gameCharacter.location.name != 'table' && gameCharacter.location.name != 'parts') return false;
    return gameCharacter.targeted;
  }

  private targetedGameCharacterList( ): GameCharacter[]{
    let objects :GameCharacter[] = [];
    objects = ObjectStore.instance
        .getObjects<GameCharacter>(GameCharacter)
        .filter(character => this.targeted(character));
    return objects;
  }

  sendChat(value: { text: string, gameSystem: GameSystemClass, sendFrom: string, sendTo: string ,tachieNum: number , messColor:string, imageIdentifier?: string }) {
    if (this.chatTab) {
      let outtext = '';
      let objects: GameCharacter[] = [];
      let messageTargetContext: ChatMessageTargetContext[] = [];

      Logger.debug(value.text + ':'+ this.checkTargetCharactor(value.text));

      if ( this.checkTargetCharactor(value.text)) {
        objects = this.targetedGameCharacterList();
        let first = true;
        if (objects.length == 0) {
          outtext += '対象が未選択です'
        }
        for(let object of objects){
          outtext += first ? '' : '\n'
          let str = value.text;
          let str2 = '';
          if( first){
            str2 = str;
          }else{
            //自分リソース操作指定の省略
            str2 = DiceBot.deleteMyselfResourceBuff(str);
          }

          outtext += str2;
          outtext += ' ['+object.name + ']';
          first = false;

          let targetContext: ChatMessageTargetContext = {
            text: '',
            object: null
          };
          targetContext.text = str2;
          targetContext.object = object;
          messageTargetContext.push( targetContext);
        }
      }else{
        outtext = value.text;
        let targetContext: ChatMessageTargetContext = {
          text: '',
          object: null
        };
        targetContext.text = value.text;
        targetContext.object = null;
        messageTargetContext.push( targetContext);
      }
      this.chatMessageService.sendMessage(this.chatTab, outtext, value.gameSystem, value.sendFrom, value.sendTo, value.tachieNum, value.messColor, messageTargetContext, false, value.imageIdentifier);
    }
  }

  trackByChatTab(index: number, chatTab: ChatTab) {
    return chatTab.identifier;
  }
}
