import { AfterViewInit, ChangeDetectorRef, Component, NgZone, OnDestroy, OnInit } from '@angular/core';
import { Logger } from '../../class/core/system/util/logger';

import { ObjectStore } from '@udonarium/core/synchronize-object/object-store';
import { ForceRoomResyncResult, InitialRoomSync } from '@udonarium/core/synchronize-object/initial-room-sync';
import { ChatTabList } from '@udonarium/chat-tab-list';
import { PeerContext } from '@udonarium/core/system/network/peer-context';
import { EventSystem, Network } from '@udonarium/core/system';
import { PeerCursor } from '@udonarium/peer-cursor';

import { FileSelecterComponent } from 'component/file-selecter/file-selecter.component';
import { LobbyComponent } from 'component/lobby/lobby.component';
import { ReConnectComponent } from 'component/re-connect/re-connect.component';
import { AppConfigService } from 'service/app-config.service';
import { ModalService } from 'service/modal.service';
import { PanelService } from 'service/panel.service';
import { GmModeService } from 'service/gm-mode.service';
import { ChatMessageService } from 'service/chat-message.service';

import { TabletopActionService } from 'service/tabletop-action.service';
import { TableSelecter } from '@udonarium/table-selecter';

import { Card } from '@udonarium/card';
import { CardStack } from '@udonarium/card-stack';
import { GameObject } from '@udonarium/core/synchronize-object/game-object';
import { DiceSymbol } from '@udonarium/dice-symbol';
import { GameCharacter } from '@udonarium/game-character';
import { GameTableMask } from '@udonarium/game-table-mask';
import { RangeArea } from '@udonarium/range';
import { Terrain } from '@udonarium/terrain';
import { TextNote } from '@udonarium/text-note';

import { CutIn } from '@udonarium/cut-in';
import { DiceTable } from '@udonarium/dice-table';

const GM_CURSOR_SHARE_DISABLED_KEY = 'udonarium.gm.cursorShareDisabled';


@Component({
  selector: 'peer-menu',
  templateUrl: './peer-menu.component.html',
  styleUrls: ['./peer-menu.component.css']
})
export class PeerMenuComponent implements OnInit, OnDestroy, AfterViewInit {

  targetUserId = '';
  networkService = Network;
  gameRoomService = ObjectStore.instance;
  help: string = '';
  isPasswordVisible = false;
  isOperationHelpOpen = false;
  disptimer = null;
  dispDetailFlag = false;
  isGmCursorShareDisabled = this.loadGmCursorShareDisabled();
  isForceResyncRunning = false;
  private forceResyncRequested = false;
  private forceResyncSyncId = '';
  private forceResyncCooldownUntil = 0;
  private forceResyncTimeout: any = null;

  get forceResyncCooldownSeconds(): number {
    return Math.max(0, Math.ceil((this.forceResyncCooldownUntil - Date.now()) / 1000));
  }
  get isForceResyncDisabled(): boolean {
    return !this.networkService.isOpen || this.isForceResyncRunning || 0 < this.forceResyncCooldownSeconds;
  }
  get forceResyncButtonLabel(): string {
    return this.isForceResyncRunning ? '再同期中…' : '強制再同期';
  }

  get myPeer(): PeerCursor { return PeerCursor.myCursor; }
  get isGmMode(): boolean { return this.gmModeService.isGm; }
  get gmPeers(): PeerCursor[] {
    return ObjectStore.instance.getObjects<PeerCursor>(PeerCursor)
      .filter(peer => !!peer.isGmMode && !peer.isDisConnect);
  }
  get cursorHiddenPeers(): PeerCursor[] {
    return ObjectStore.instance.getObjects<PeerCursor>(PeerCursor)
      .filter(peer => !!peer.isCursorShareDisabled && !peer.isDisConnect);
  }

  constructor(
    private tabletopActionService: TabletopActionService,
    private changeDetector: ChangeDetectorRef,
    private ngZone: NgZone,
    private modalService: ModalService,
    private panelService: PanelService,
    public gmModeService: GmModeService,
    private chatMessageService: ChatMessageService,
    public appConfigService: AppConfigService
  ) { }

  get tableSelecter(): TableSelecter { return TableSelecter.instance; }

  ngOnInit() {
    Promise.resolve().then(() => this.panelService.title = '接続情報');
    Promise.resolve().then(() => {
      if (!this.myPeer) return;
      this.myPeer.isCursorShareDisabled = this.isGmCursorShareDisabled;
      this.myPeer.update();
    });
  }

  ngAfterViewInit() {
    EventSystem.register(this)
      .on('OPEN_NETWORK', event => {
        this.ngZone.run(() => { });
      })
      .on('INITIAL_ROOM_SYNC_PROGRESS', event => {
        if (!event.isSendFromSelf || !this.forceResyncRequested) return;
        this.ngZone.run(() => this.handleForceResyncProgress(event.data));
      });

    this.disptimer = setInterval(() => {
      this.dispInfo();
    }, 1000 );
  }

  ngOnDestroy() {
    EventSystem.unregister(this);
    if (this.disptimer != null) clearInterval(this.disptimer);
    if (this.forceResyncTimeout != null) clearTimeout(this.forceResyncTimeout);
    this.disptimer = null;
    this.forceResyncTimeout = null;
  }

  changeIcon() {
    this.modalService.open<string>(FileSelecterComponent).then(value => {
      if (!this.myPeer || !value) return;
      this.myPeer.imageIdentifier = value;
    });
  }

  connectPeer() {
    let targetUserId = this.targetUserId;
    this.targetUserId = '';
    if (targetUserId.length < 1) return;
    this.help = '';
    let context = PeerContext.create(targetUserId);
    if (context.isRoom) return;
    ObjectStore.instance.clearDeleteHistory();
    Network.connect(context.peerId);
  }

  showLobby() {
    this.modalService.open(LobbyComponent, { width: 700, height: 400, left: 0, top: 400 });
  }

  showReConnect() {
    this.modalService.open(ReConnectComponent, { width: 700, height: 400, left: 0, top: 400 });
  }

  forceResync() {
    if (this.isForceResyncDisabled) return;
    const confirmed = window.confirm(
      '接続中の参加者またはサーバーから部屋データを再取得します。\n' +
      '表示ずれや再接続後の不整合がある場合だけ実行してください。\n\n強制再同期を開始しますか？'
    );
    if (!confirmed) return;

    this.forceResyncRequested = true;
    this.forceResyncSyncId = '';
    this.isForceResyncRunning = true;
    this.help = '再同期データを要求しています。操作せずにお待ちください。';
    this.startForceResyncTimeout();

    // Central relay has its own canonical snapshot. SkyWay P2P falls back to
    // the ZIP snapshot path and tries connected peers in connection-quality order.
    if (Network.forceResync()) return;
    const result: ForceRoomResyncResult = InitialRoomSync.instance.forceResync();
    if (result === 'started') return;

    this.forceResyncRequested = false;
    this.isForceResyncRunning = false;
    this.clearForceResyncTimeout();
    switch (result) {
      case 'busy':
        this.help = 'すでに同期処理中です。完了してからもう一度お試しください。';
        break;
      case 'no-peer':
        this.help = '再同期元になる参加者が見つかりません。ほかの参加者の接続を確認してください。';
        break;
      default:
        this.help = 'ネットワークに接続されていないため、再同期を開始できませんでした。';
        break;
    }
  }

  private handleForceResyncProgress(data: any) {
    const phase = typeof data?.phase === 'string' ? data.phase : '';
    const syncId = typeof data?.syncId === 'string' ? data.syncId : '';
    if (this.forceResyncSyncId && syncId && this.forceResyncSyncId !== syncId) return;
    if (!this.forceResyncSyncId && syncId && (phase === 'preparing' || phase === 'downloading' || phase === 'extracting' || phase === 'applying')) {
      this.forceResyncSyncId = syncId;
    }
    const done = Number.isSafeInteger(data?.done) ? data.done : 0;
    const total = Number.isSafeInteger(data?.total) ? data.total : 0;
    switch (phase) {
      case 'preparing':
        this.help = '再同期用ZIPを準備しています。';
        break;
      case 'downloading':
        this.help = 0 < total ? `再同期データを受信中です（${Math.floor(done / total * 100)}%）。` : '再同期データを受信しています。';
        break;
      case 'extracting':
        this.help = '再同期データを展開しています。';
        break;
      case 'applying':
        this.help = 0 < total ? `部屋データを反映中です（${done.toLocaleString()} / ${total.toLocaleString()}件）。` : '部屋データを反映しています。';
        break;
      case 'complete':
        this.finishForceResync(true, '強制再同期が完了しました。表示内容を確認してください。');
        break;
      case 'fallback':
        this.finishForceResync(false, 'ZIP再同期に失敗したため、互換同期へ切り替えました。少し待ってから表示を確認してください。');
        break;
      case 'failed':
        this.finishForceResync(false, '強制再同期に失敗しました。接続状態を確認してから再実行してください。');
        break;
    }
  }

  private startForceResyncTimeout() {
    this.clearForceResyncTimeout();
    this.forceResyncTimeout = setTimeout(() => {
      this.ngZone.run(() => {
        if (!this.forceResyncRequested) return;
        this.finishForceResync(false, '再同期が180秒以内に完了しませんでした。接続状態を確認してください。');
      });
    }, 180 * 1000);
  }

  private clearForceResyncTimeout() {
    if (this.forceResyncTimeout != null) clearTimeout(this.forceResyncTimeout);
    this.forceResyncTimeout = null;
  }

  private finishForceResync(success: boolean, message: string) {
    this.clearForceResyncTimeout();
    this.forceResyncRequested = false;
    this.forceResyncSyncId = '';
    this.isForceResyncRunning = false;
    this.forceResyncCooldownUntil = Date.now() + (success ? 30 : 10) * 1000;
    this.help = message;
  }

  saveSnapshot() {
    const ok = Network.manualSaveSnapshot();
    this.help = ok
      ? 'ルームデータをサーバーに保存しました。次に参加する人がデータを受け取りやすくなります。'
      : '保存に失敗しました。部屋に入室済みであることを確認してください。';
  }

  toggleGmCursorShareDisabled() {
    this.isGmCursorShareDisabled = !this.isGmCursorShareDisabled;
    try {
      localStorage.setItem(GM_CURSOR_SHARE_DISABLED_KEY, this.isGmCursorShareDisabled ? '1' : '0');
    } catch (e) {
      Logger.warn('GM cursor sharing localStorage save failed', e);
    }
    if (this.myPeer) {
      this.myPeer.isCursorShareDisabled = this.isGmCursorShareDisabled;
      this.myPeer.update();
    }
    EventSystem.trigger('GM_CURSOR_SHARE_DISABLED_CHANGED', { disabled: this.isGmCursorShareDisabled });
    this.sendCursorShareSystemLog();
  }

  private sendCursorShareSystemLog() {
    const chatTabList = ObjectStore.instance.get<ChatTabList>('ChatTabList');
    const sysTab = chatTabList ? chatTabList.systemMessageTab : null;
    const name = this.myPeer && this.myPeer.name ? this.myPeer.name : (this.myPeer ? this.myPeer.userId : '誰か');
    const status = this.isGmCursorShareDisabled ? 'OFF' : 'ON';
    if (sysTab) this.chatMessageService.sendSystemMessage(sysTab, `${name} がカーソル共有を${status}にしました。`);
  }

  private loadGmCursorShareDisabled(): boolean {
    try {
      return localStorage.getItem(GM_CURSOR_SHARE_DISABLED_KEY) === '1';
    } catch (e) {
      return false;
    }
  }

  togglePasswordVisibility() {
    this.isPasswordVisible = !this.isPasswordVisible;
  }

  toggleOperationHelp() {
    this.isOperationHelpOpen = !this.isOperationHelpOpen;
  }

  openGuideSite() {
    window.open('https://udonarium-lycoris.ddns.net/docs/guide/index.html', '_blank');
  }

  findUserId(peerId: string) {
    const peerCursor = PeerCursor.findByPeerId(peerId);
    return peerCursor ? peerCursor.userId : '';
  }

  findPeerName(peerId: string) {
    const peerCursor = PeerCursor.findByPeerId(peerId);
    return peerCursor ? peerCursor.name : '';
  }

  findPeerIsGm(peerId: string) {
    const peerCursor = PeerCursor.findByPeerId(peerId);
    return peerCursor ? !!peerCursor.isGmMode : false;
  }

  findPeerTimeSend(peerId: string) {
    const peerCursor = PeerCursor.findByPeerId(peerId);
    return peerCursor ? peerCursor.timestampSend : 0 ;
  }

  findPeerTimeReceive(peerId: string) {
    const peerCursor = PeerCursor.findByPeerId(peerId);
    return peerCursor ? peerCursor.timestampReceive : 0 ;
  }

  findPeerTimeDiffUp(peerId: string) {
    const peerCursor = PeerCursor.findByPeerId(peerId);
    return peerCursor ? peerCursor.timeDiffUp : 0 ;
  }

  findPeerTimeDiffDown(peerId: string) {
    const peerCursor = PeerCursor.findByPeerId(peerId);
    return peerCursor ? peerCursor.timeDiffDown : 0 ;
  }

  findPeerTimeLatency(peerId: string) {
    const peerCursor = PeerCursor.findByPeerId(peerId);
    if ( !peerCursor ) return '--';

    return peerCursor ? peerCursor.timeLatency / 1000 : 99999 ;
  }

  findPeerDegreeOfSuccess(peerId: string) {
    const peerCursor = PeerCursor.findByPeerId(peerId);
    if (!peerCursor) return '0/0';
    if (peerCursor.firstTimeSignNo < 0) return '0/0';
    const degree = (peerCursor.totalTimeSignNum) + '/' + (peerCursor.lastTimeSignNo - peerCursor.firstTimeSignNo + 1);
    return degree ;
  }

  checkConnect(){
    Logger.debug("自身のUserid:" + this.networkService.peerContext.userId );
    for (let context of this.networkService.peerContexts){
      Logger.debug("接続対象ID:" + context.peerId );
    }
  }

  myTime = 0;
  dispInfo(){
    this.myTime = Date.now();
  }

}
