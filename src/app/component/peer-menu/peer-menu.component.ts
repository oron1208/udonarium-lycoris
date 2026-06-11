import { AfterViewInit, ChangeDetectorRef, Component, NgZone, OnDestroy, OnInit } from '@angular/core';

import { ObjectStore } from '@udonarium/core/synchronize-object/object-store';
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
      });

    this.disptimer = setInterval(() => {
      this.dispInfo();
    }, 1000 );
  }

  ngOnDestroy() {
    EventSystem.unregister(this);
    this.disptimer = null;
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
    Network.forceResync();
    this.help = '強制再同期を要求しました。数秒待ってから表示を確認してください。';
  }

  toggleGmCursorShareDisabled() {
    this.isGmCursorShareDisabled = !this.isGmCursorShareDisabled;
    try {
      localStorage.setItem(GM_CURSOR_SHARE_DISABLED_KEY, this.isGmCursorShareDisabled ? '1' : '0');
    } catch (e) {
      console.warn('GM cursor sharing localStorage save failed', e);
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
    console.log("自身のUserid:" + this.networkService.peerContext.userId );
    for (let context of this.networkService.peerContexts){
      console.log("接続対象ID:" + context.peerId );
    }
  }

  myTime = 0;
  dispInfo(){
    this.myTime = Date.now();
  }

}
