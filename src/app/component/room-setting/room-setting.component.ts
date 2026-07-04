import { Component, OnDestroy, OnInit } from '@angular/core';
import { Logger } from '../../class/core/system/util/logger';

import { PeerContext } from '@udonarium/core/system/network/peer-context';
import { ObjectStore } from '@udonarium/core/synchronize-object/object-store';
import { EventSystem, Network } from '@udonarium/core/system';
import { GameTable, RoomMode } from '@udonarium/game-table';
import { PeerCursor } from '@udonarium/peer-cursor';

import { ModalService } from 'service/modal.service';
import { PanelService } from 'service/panel.service';

@Component({
  selector: 'room-setting',
  templateUrl: './room-setting.component.html',
  styleUrls: ['./room-setting.component.css']
})
export class RoomSettingComponent implements OnInit, OnDestroy {
  peers: PeerContext[] = [];
  isReloading: boolean = false;

  roomName: string = 'ふつうの部屋';
  password: string = '';
  isPrivate: boolean = false;
  roomMode: RoomMode = 'standard';

  get peerId(): string { return Network.peerId; }
  get isConnected(): boolean { return Network.peerIds.length <= 1 ? false : true; }
  validateLength: boolean = false;

  get myPeer(): PeerCursor { return PeerCursor.myCursor; }

  constructor(
    private panelService: PanelService,
    private modalService: ModalService
  ) { }

  ngOnInit() {
    Promise.resolve().then(() => this.modalService.title = this.panelService.title = 'ルーム作成');
    EventSystem.register(this);
    this.calcPeerId(this.roomName, this.password);
  }

  ngOnDestroy() {
    EventSystem.unregister(this);
  }

  calcPeerId(roomName: string, password: string) {
    let userId = Network.peerContext ? Network.peerContext.userId : PeerContext.generateId();
    let context = PeerContext.create(userId, PeerContext.generateId('***'), roomName, password);
    this.validateLength = context.peerId.length < 64 ? true : false;
    this.myPeer.reConnectPass = password;

  }

  createRoom() {
    let userId = Network.peerContext ? Network.peerContext.userId : PeerContext.generateId();
    this.savePendingRoomMode();
    Network.open(userId, PeerContext.generateId('***'), this.roomName, this.password);
    this.applyRoomModeToCurrentTables();
    PeerCursor.myCursor.peerId = Network.peerId;
    this.myPeer.reConnectPass = this.password;
    this.modalService.resolve();
  }

  private savePendingRoomMode() {
    try {
      localStorage.setItem('udonarium.pendingRoomMode.v1', this.roomMode);
    } catch (e) {
      Logger.warn('room mode localStorage save failed', e);
    }
  }

  private applyRoomModeToCurrentTables() {
    const tables = ObjectStore.instance.getObjects(GameTable);
    tables.forEach(table => {
      table.roomMode = this.roomMode;
      table.update();
    });
  }
}
