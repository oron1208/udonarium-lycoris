import {
  Channel,
  LocalDataStream,
  LocalPerson,
  Publication,
  SkyWayChannel,
  SkyWayContext,
  SkyWayError,
  SkyWayStreamFactory,
  Subscription,
  Logger as SkyWayLogger
} from '@skyway-sdk/core';
import { CryptoUtil } from '../../util/crypto-util';
import { IPeerContext, PeerContext } from '../peer-context';
import { SkyWayBackend } from './skyway-backend';
import { Logger } from '../../util/logger';

export class SkyWayFacade {
  url = '';
  context!: SkyWayContext;
  private lobby!: Channel;
  private lobbyPerson!: LocalPerson;
  room!: Channel;
  roomPerson!: LocalPerson;

  publication!: Publication<LocalDataStream>;

  peer: PeerContext = PeerContext.parse('???');
  get isOpen(): boolean { return this.peer.isOpen };
  private isDestroyed = false;

  onOpen!: (peer: IPeerContext) => void;
  onClose!: (peer: IPeerContext) => void;
  onFatalError!: (peer: IPeerContext, errorType: string, errorMessage: string, errorObject: any) => void;
  onSubscribed!: (peer: IPeerContext, subscription: Subscription) => void;
  onRoomRestore!: (peer: IPeerContext) => void;

  async open(peer: IPeerContext) {
    if (this.isOpen) await this.close();
    try {
      Logger.debug('SkyWayFacade open...');
      this.peer = PeerContext.parse(peer.peerId);
      this.peer.userId = peer.userId;
      this.peer.password = peer.password;
      this.peer.roomChannelName = peer.roomChannelName;
      this.peer.isDeveloperJoin = peer.isDeveloperJoin;
      this.isDestroyed = false;

      await this.createContext();
      await this.joinRoom();
      await this.joinLobby();

      this.peer.isOpen = true;
      Logger.debug('SkyWayFacade open ok');

      if (this.onOpen) this.onOpen(this.peer);
    } catch (err) {
      Logger.error(err);
      if (this.onFatalError) this.onFatalError(this.peer, err.name, err.message, err);
    }
  }

  async close() {
    try {
      Logger.debug('SkyWayFacade close...');
      this.peer = PeerContext.parse('???');
      this.isDestroyed = true;

      await this.leaveLobby();
      await this.leaveRoom();
      await this.disposeContext();
      Logger.debug('SkyWayFacade close ok');
    } catch (err) {
      Logger.error(err);
    }
  }

  private async createContext() {
    await this.disposeContext();
    if (this.isDestroyed) return;

    let backend = new SkyWayBackend(this.url);
    let channelName = this.peer.isRoom
      ? (this.peer.roomChannelName || CryptoUtil.sha256Base64Url(this.peer.roomId + this.peer.roomName + this.peer.password))
      : this.peer.peerId;

    let authToken = await backend.createSkyWayAuthToken(channelName, this.peer.peerId);
    if (authToken.length < 1) {
      let message = `APIバックエンド< ${backend.url} >にアクセスできませんでした。SkyWayの認証トークンを発行するサーバが必要です。`
      if (this.onFatalError) this.onFatalError(this.peer, 'server-error', message, new Error(message));
      return;
    }

    let context = await SkyWayContext.Create(authToken, {
      rtcConfig: {
        turnPolicy: 'enable',
        turnProtocol: 'all',
        stunPolicy: 'enable',
        stunPorts: [443, 3478],
      },
      token: {
        updateRemindSec: 120,
      },
      member: {
        keepaliveIntervalSec: 30,
        keepaliveIntervalGapSec: 10,
        preventAutoLeaveOnBeforeUnload: false,
      },
    });
    context.onTokenUpdateReminder.add(async () => {
      Logger.debug(`skyWay onTokenUpdateReminder ${new Date().toISOString()}`);
      let authToken = await backend.createSkyWayAuthToken(channelName, this.peer.peerId);
      if (authToken.length < 1) {
        let message = `APIバックエンド< ${backend.url} >にアクセスできませんでした。`
        if (this.onFatalError) this.onFatalError(this.peer, 'server-error', message, new Error(message));
        return;
      }
      context.updateAuthToken(authToken);
    });

    context.onTokenExpired.add(() => {
      Logger.error('skyWay onTokenExpired');
      if (this.isOpen) {
        this.close();
        if (this.onClose) this.onClose(this.peer);
      }
      let message = 'SkyWayの認証トークンの有効期限が切れました。'
      if (this.onFatalError) this.onFatalError(this.peer, 'token-expired', message, new Error(message));
    });

    context.onFatalError.add(err => {
      Logger.error('skyWay onFatalError', err);
      if (this.isOpen) {
        this.close();
        if (this.onClose) this.onClose(this.peer);
      }
      if (this.onFatalError) this.onFatalError(this.peer, err.name, err.message, err);
    });

    this.context = context;
  }

  private async joinLobby() {
    await this.joinLobbyChannel();
    await this.joinLobbyPerson();
  }

  private async joinLobbyChannel() {
    await this.leaveLobbyChannel();
    if (this.isDestroyed || !this.peer.isRoom || !this.context || this.context?.disposed) return;

    let lobbys: Channel[] = [];
    for (let lobbyName of this.getLobbyNames()) {
      let lobby = await SkyWayChannel.FindOrCreate(this.context, {
        name: lobbyName,
      });
      Logger.debug(`FindOrCreate<${lobbyName}>`);
      lobbys.push(lobby);
      if (lobby.members.length < 300) break;
    }

    let min = 9999;
    let joinLobby: Channel = null;
    lobbys.forEach(lobby => {
      if (min <= lobby.members.length) return;
      min = lobby.members.length;
      joinLobby = lobby;
    });

    lobbys.forEach(lobby => {
      if (lobby !== joinLobby) lobby.dispose();
    });

    joinLobby.onClosed.add(() => {
      Logger.debug(`lobby<${joinLobby.name}> onClosed`);
      this.joinLobby();
    });

    this.lobby = joinLobby;
  }

  private async joinLobbyPerson() {
    await this.leaveLobbyPerson();
    if (this.isDestroyed || !this.peer.isRoom || !this.context || this.context?.disposed || this.lobby == null) return;

    let lobbyPerson = await this.lobby.join({
      name: this.peer.peerId,
    });

    Logger.debug(`lobbyPerson join <${this.lobby.name}>`);
    lobbyPerson.onLeft.add(() => {
      Logger.debug(`lobbyPerson onClosed`);
    });

    lobbyPerson.onFatalError.add(err => {
      Logger.error('lobbyPerson onFatalError', err);
    });

    this.lobbyPerson = lobbyPerson;
  }

  private async joinRoom() {
    await this.joinRoomChannel();
    await this.joinRoomPerson();
    await this.createRoomDataStream();
  }

  private async joinRoomChannel() {
    await this.leaveRoomChannel();
    if (this.isDestroyed || !this.peer.isRoom || !this.context || this.context?.disposed) return;

    let roomName = this.peer.roomChannelName || CryptoUtil.sha256Base64Url(this.peer.roomId + this.peer.roomName + this.peer.password);
    Logger.debug(`roomName: ${roomName}`);

    let room = await SkyWayChannel.FindOrCreate(this.context, {
      name: roomName,
    });
    Logger.debug(`FindOrCreate<${roomName}>`);

    room.onClosed.add(async () => {
      Logger.debug(`room<${room.name}> onClosed`);
      await this.joinRoom();
      Logger.debug(`room<${room.name}> onRoomRestore`);
      if (this.onRoomRestore) this.onRoomRestore(this.peer);
    });

    this.room = room;
  }

  private async joinRoomPerson() {
    await this.leaveRoomPerson();
    if (this.isDestroyed || !this.peer.isRoom || !this.context || this.context?.disposed || this.room == null) return;

    let roomPerson = await this.room.join({
      name: this.peer.peerId
    });

    Logger.debug(`roomPerson join <${this.room.name}>`);

    roomPerson.onFatalError.add(err => {
      Logger.error('roomPerson onFatalError', err);
      if (this.isOpen) {
        this.close();
        if (this.onClose) this.onClose(this.peer);
      }
      if (this.onFatalError) this.onFatalError(this.peer, err.name, err.message, err);
    });

    this.roomPerson = roomPerson;
  }

  private async createRoomDataStream() {
    if (this.isDestroyed || !this.peer.isRoom || !this.context || this.context?.disposed || this.roomPerson == null) return;
    let dataStream = await SkyWayStreamFactory.createDataStream();
    let publication = await this.roomPerson.publish(dataStream, { metadata: 'udonarium-data-stream' });

    publication.onSubscribed.add(async event => {
      Logger.debug(`publication onSubscribed ${event.subscription.subscriber.name}`);
      let peerId = event.subscription.subscriber.name;
      if (peerId == null) {
        await this.cancelSubscription(event.subscription);
        return;
      }

      let peer = PeerContext.parse(event.subscription.subscriber.name);
      if (this.onSubscribed) this.onSubscribed(peer, event.subscription);
    });

    this.publication = publication;
  }

  private async disposeContext() {
    let context = this.context;
    this.context = null;
    if (!context) return;
    Logger.debug('disposeContext');
    context.dispose();
  }

  private async leaveLobby() {
    await this.leaveLobbyPerson();
    await this.leaveLobbyChannel();
  }

  private async leaveLobbyChannel() {
    let lobby = this.lobby;
    this.lobby = null;

    if (!lobby) return;
    Logger.debug('leaveLobbyChannel');
    lobby.dispose();
  }

  private async leaveLobbyPerson() {
    let lobbyPerson = this.lobbyPerson;
    this.lobbyPerson = null;

    if (!lobbyPerson || lobbyPerson.state === 'left') return;
    Logger.debug('leaveLobbyPerson');
    lobbyPerson.onLeft.removeAllListeners();
    lobbyPerson.onFatalError.removeAllListeners();
    await lobbyPerson.leave();
  }

  private async leaveRoom() {
    await this.closeRoomDataStream();
    await this.leaveRoomPerson();
    await this.leaveRoomChannel();
  }

  private async leaveRoomChannel() {
    let room = this.room;
    this.room = null;

    if (!room) return;
    Logger.debug('leaveRoomChannel');
    room.onMemberJoined.removeAllListeners();
    room.onMemberLeft.removeAllListeners();
    room.onMemberListChanged.removeAllListeners();
    room.onStreamPublished.removeAllListeners();
    room.onClosed.removeAllListeners();
    room.dispose();
  }

  private async leaveRoomPerson() {
    let roomPerson = this.roomPerson;
    this.roomPerson = null;

    if (!roomPerson || roomPerson.state === 'left') return;
    Logger.debug('leaveRoomPerson');
    roomPerson.onLeft.removeAllListeners();
    roomPerson.onFatalError.removeAllListeners();
    await roomPerson.leave();
  }

  private async closeRoomDataStream() {
    let publication = this.publication;
    this.publication = null;

    if (!publication) return;
    await this.cancelPublication(publication);
  }

  /**
   * SkyWay SDK v1/v2 互換の購読解除。
   * v1: subscription.cancel()
   * v2: subscription.unsubscribe() または member.unsubscribe(subscription.id)
   */
  private async cancelSubscription(subscription: Subscription) {
    const anySubscription = subscription as any;
    if (typeof anySubscription.cancel === 'function') {
      await anySubscription.cancel();
      return;
    }
    if (typeof anySubscription.unsubscribe === 'function') {
      await anySubscription.unsubscribe();
      return;
    }
    if (this.roomPerson && typeof (this.roomPerson as any).unsubscribe === 'function') {
      await (this.roomPerson as any).unsubscribe(anySubscription.id);
    }
  }

  /**
   * SkyWay SDK v1/v2 互換の公開解除。
   * v1: publication.cancel()
   * v2: publication.unpublish() または member.unpublish(publication.id)
   */
  private async cancelPublication(publication: Publication<LocalDataStream>) {
    const anyPublication = publication as any;
    if (typeof anyPublication.cancel === 'function') {
      await anyPublication.cancel();
      return;
    }
    if (typeof anyPublication.unpublish === 'function') {
      await anyPublication.unpublish();
      return;
    }
    if (this.roomPerson && typeof (this.roomPerson as any).unpublish === 'function') {
      await (this.roomPerson as any).unpublish(anyPublication.id);
    }
  }

  async listAllPeers(): Promise<string[]> {
    if (this.isDestroyed || !this.isOpen) return [];

    let lobbys: Channel[] = [];
    for (let lobbyName of this.getLobbyNames()) {
      let level = SkyWayLogger.level;
      SkyWayLogger.level = 'disable';
      try {
        let lobby = this.lobby?.name === lobbyName ? this.lobby : await SkyWayChannel.Find(this.context, { name: lobbyName });
        lobbys.push(lobby);
      } catch (error) {
        if (error instanceof SkyWayError) {
          if (error.name != 'channelNotFound') Logger.error(`${error.name} ${error.message}`);
        } else {
          Logger.error(error);
        }
      }
      SkyWayLogger.level = level;
    }

    let allPeerIds = lobbys.flatMap(lobby => lobby.members.map(member => member.name ?? '???'));

    lobbys.forEach(lobby => {
      if (lobby.name !== this.lobby?.name) lobby.dispose();
    });
    return allPeerIds;
  }

  private getLobbyNames(): string[] {
    let names: Set<string> = new Set();
    let wildcards: Set<string> = new Set();
    let maxLobbySize = 0;

    // udonarium-lobby-* -> udonarium-lobby-1, udonarium-lobby-2, ...
    // udonarium-lobby-*-of-4 -> udonarium-lobby-1-of-4, udonarium-lobby-2-of-4, ...
    const tokenScope: any = (this.context?.authToken as any)?.scope ?? {};
    const lobbyScopes = tokenScope?.app?.channels ?? tokenScope?.rooms ?? [];
    for (let channel of lobbyScopes) {
      let name = channel.name ?? '';
      if (name.startsWith('udonarium-lobby-')) {
        if (name.includes('*')) {
          wildcards.add(name);
        } else {
          names.add(name);
        }
        try {
          let regArray = /-(\d+)$/.exec(name);
          Logger.debug(regArray);
          let lobbySize = regArray && 1 < regArray.length ? Number(regArray[1]) : 0;
          if (isNaN(lobbySize)) lobbySize = 0;
          if (maxLobbySize < lobbySize) maxLobbySize = lobbySize;
        } catch (e) {
          Logger.warn(e);
        }
      }
    }

    for (let wildcard of wildcards) {
      [...Array(maxLobbySize)].map((value, index) => names.add(wildcard.replace('*', `${index + 1}`)));
    }

    let sorted = Array.from(names).sort((a, b) => {
      let aIndex = a.replace(/\d+/g, m => m.padStart(10, '0'));
      let bIndex = b.replace(/\d+/g, m => m.padStart(10, '0'));
      return aIndex < bIndex ? -1 : aIndex > bIndex ? 1 : 0;
    });

    return sorted;
  }
}
