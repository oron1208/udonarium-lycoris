import { compressAsync, decompressAsync } from '../../util/compress';
import { MessagePack } from '../../util/message-pack';
import { setZeroTimeout } from '../../util/zero-timeout';
import { Connection, ConnectionCallback } from '../connection';
import { IPeerContext, PeerContext } from '../peer-context';
import { PeerSessionGrade } from '../peer-session-state';
import { IRoomInfo, RoomInfo } from '../room-info';
import { SkyWayDataStream } from './skyway-data-stream';
import { SkyWayDataStreamList } from './skyway-data-stream-list';
import { SkyWayFacade } from './skyway-facade';
import { Logger } from '../../util/logger';

type PeerId = string;

interface DataContainer {
  data: Uint8Array;
  users?: string[];
  peerIds?: string[];
  senderUserId?: string;
  ttl: number;
  isCompressed?: boolean;
}

export class SkyWayConnection implements Connection {
  private get userIds(): string[] { return this.peers.map(peer => peer.userId).filter(userId => 0 < userId.length).concat([this.peer.userId]); }

  get peerId(): string { return this.peer.peerId; }
  get peerIds(): string[] { return this.streams.peerIds; }

  get peer(): PeerContext { return this.skyWay.peer; }
  get peers(): PeerContext[] { return this.streams.peers; }
  get peerContext(): PeerContext { return this.peer; }
  get peerContexts(): PeerContext[] { return this.peers; }

  readonly callback: ConnectionCallback = new ConnectionCallback();
  bandwidthUsage: number = 0;

  private readonly skyWay: SkyWayFacade = new SkyWayFacade();
  private readonly streams: SkyWayDataStreamList = new SkyWayDataStreamList();

  private listAllPeersCache: PeerId[] = [];
  private httpRequestInterval: number = performance.now() + 500;

  private outboundQueue: Promise<any> = Promise.resolve();
  private inboundQueue: Promise<any> = Promise.resolve();

  private readonly trustedPeerIds: Set<PeerId> = new Set();
  private readonly relayingPeerIds: Map<string, string[]> = new Map();
  private readonly maybeUnavailablePeerIds: Set<string> = new Set();

  private recoveryTimer: ReturnType<typeof setInterval> | null = null;
  private readonly connectingSince = new Map<string, number>();

  configure(config: any) {
    this.skyWay.url = config?.backend?.url ?? '';
  }

  setApiKey(key: string) { /* SkyWay 2023 uses backend-issued tokens, not client API keys. */ }
  setSignalingUrl(url: string) { if (url) this.skyWay.url = url; }
  setIceServers(iceServers: RTCIceServer[]) { /* SkyWay 2023 controls ICE via SkyWay platform/backend token. */ }
  forceResync(): boolean { return false; /* InitialRoomSync handles P2P ZIP resync. */ }

  open(userId?: string)
  open(userId: string, roomId: string, roomName: string, password: string)
  open(...args: any[]) {
    Logger.debug('open', args);
    let peer: PeerContext;
    if (args.length === 0) {
      peer = PeerContext.create(PeerContext.generateId());
    } else if (args.length === 1) {
      peer = PeerContext.create(args[0]);
    } else {
      peer = PeerContext.create(args[0], args[1], args[2], args[3]);
    }
    this.trustedPeerIds.clear();
    this.openSkyWay(peer);
  }

  close() {
    if (this.recoveryTimer != null) clearInterval(this.recoveryTimer);
    this.recoveryTimer = null;
    this.disconnectAll();
    this.skyWay.close();
  }

  connect(peerOrId: IPeerContext | string): boolean {
    const peer = typeof peerOrId === 'string' ? PeerContext.parse(peerOrId) : peerOrId;
    if (!this.peer.isRoom) {
      Logger.warn('connect() is Fail. ルーム接続のみ可能');
      let errorType = 'udonarium-unsupported';
      let errorMessage = '現在のユドナリウムでSkyWay(2023)を使用する場合、プライベート接続は利用できません。ルーム接続機能を利用してください。';
      if (this.callback.onError) this.callback.onError(this.peer.peerId, errorType, errorMessage, {});
      return false;
    }

    if (!this.shouldConnect(peer.peerId)) return false;

    Logger.debug(`connect() ${peer.peerId}`);
    this.connectStream(SkyWayDataStream.createSubscription(this.skyWay, peer));
    return true;
  }

  private shouldConnect(peerId: string): boolean {
    if (!this.skyWay.isOpen) {
      Logger.debug('connect() is Fail. IDが割り振られるまで待てや');
      return false;
    }

    if (this.peerId === peerId) {
      Logger.debug('connect() is Fail. ' + peerId + ' is me.');
      return false;
    }

    if (this.streams.find(peerId)) {
      Logger.debug('connect() is Fail. <' + peerId + '> is already connecting.');
      return false;
    }

    if (!this.peer.verifyPeer(peerId)) {
      Logger.debug('connect() is Fail. <' + peerId + '> is invalid.');
      return false;
    }

    if (!this.skyWay?.room?.members.find(member => member.name === peerId)) {
      Logger.debug('connect() is Fail.  <' + peerId + '> is not found.');
      return false;
    }

    if (peerId && peerId.length && peerId !== this.peerId) return true;
    return false;
  }

  disconnect(peerOrId: IPeerContext | string): boolean {
    const peer = typeof peerOrId === 'string' ? PeerContext.parse(peerOrId) : peerOrId;
    let stream = this.streams.find(peer.peerId)
    if (!stream) return false;
    this.disconnectStream(stream);
    return true;
  }

  disconnectAll() {
    for (let peer of this.peers) {
      this.disconnect(peer);
    }
  }

  send(data: any, sendTo?: string) {
    if (this.peers.length < 1) return;
    let container: DataContainer = {
      data: MessagePack.encode(data),
      ttl: 1
    }

    let byteLength = container.data.byteLength;
    this.bandwidthUsage += byteLength;
    this.outboundQueue = this.outboundQueue.then(async () => {
      await new Promise<void>(resolve => setZeroTimeout(resolve));
      try {
        if (1 * 1024 < container.data.byteLength && Array.isArray(data) && 1 < data.length) {
          let compressed = await compressAsync(container.data);
          if (compressed && compressed.byteLength < container.data.byteLength) {
            container.data = compressed;
            container.isCompressed = true;
          }
        }
        if (sendTo) this.sendUnicast(container, sendTo);
        else this.sendBroadcast(container);
      } finally {
        this.bandwidthUsage -= byteLength;
      }
    }).catch(error => Logger.error('SkyWay send failed', error));
  }

  private sendUnicast(container: DataContainer, sendTo: string) {
    container.ttl = 0;
    let stream = this.streams.find(sendTo);
    if (stream && stream.open) stream.send(container);
  }

  private sendBroadcast(container: DataContainer) {
    for (let stream of this.streams) {
      if (stream.open) stream.send(container);
    }
  }

  async listAllPeers(): Promise<string[]> {
    let now = performance.now();
    if (now < this.httpRequestInterval) {
      Logger.warn('httpRequestInterval... ' + (this.httpRequestInterval - now));
    } else {
      this.httpRequestInterval = now + 10000;
      this.listAllPeersCache = await this.skyWay.listAllPeers();
    }

    return this.listAllPeersCache;
  }

  async listAllRooms(): Promise<IRoomInfo[]> {
    let allPeerIds = await this.listAllPeers();
    return RoomInfo.listFrom(allPeerIds);
  }

  private async openSkyWay(peer: IPeerContext) {
    if (this.skyWay.context) {
      Logger.warn('It is already opened.');
      await this.skyWay.close();
    }

    this.skyWay.onOpen = peer => {
      Logger.debug('skyWay onOpen', peer);
      Logger.debug('My peer Context', this.peer);
      if (this.callback.onOpen) this.callback.onOpen(this.peer.peerId);
      if (this.recoveryTimer != null) clearInterval(this.recoveryTimer);
      this.recoveryTimer = setInterval(() => this.reconcileRoomMembers(), 5000);
      this.reconcileRoomMembers();
    };

    this.skyWay.onClose = peer => {
      Logger.debug('skyWay onClose', peer);
      if (this.peer.isOpen) this.close();
      if (this.callback.onClose) this.callback.onClose(this.peer.peerId);
    };

    this.skyWay.onFatalError = (peer, errorType, errorMessage, errorObject) => {
      Logger.error('skyWay onFatalError', errorObject);
      if (this.peer.isOpen) {
        this.close();
        if (this.callback.onClose) this.callback.onClose(this.peer.peerId);
      }
      if (this.callback.onError) this.callback.onError(this.peer.peerId, errorType, errorMessage, errorObject);
    };

    this.skyWay.onSubscribed = (peer, subscription) => {
      Logger.debug(`skyWay onSubscribed ${peer.peerId}`);
      let stream = SkyWayDataStream.createPublication(this.skyWay, peer);

      if (!this.peer.verifyPeer(stream.peer.peerId)) {
        Logger.warn('stream is closing. <' + stream.peer.peerId + '> is invalid.');
        stream.reject();
        return;
      }
      this.connectStream(stream);
    }

    this.skyWay.onRoomRestore = (peer) => {
      Logger.debug(`skyWay onRoomRestore ${peer.peerId}`);
      for (let peerId of this.trustedPeerIds) {
        let peer = PeerContext.parse(peerId);
        this.disconnect(peer);
        this.connect(peer);
      }
    }

    await this.skyWay.open(peer);
    return;
  }

  private connectStream(stream: SkyWayDataStream) {
    if (this.streams.add(stream) == null) return;
    Logger.debug(`openStream ${stream.peer.peerId}`);

    this.trustedPeerIds.delete(stream.peer.peerId);
    this.maybeUnavailablePeerIds.add(stream.peer.peerId);
    this.connectingSince.set(stream.peer.peerId, performance.now());

    stream.on('data', data => {
      this.onData(stream, data);
    });
    stream.on('open', () => {
      this.connectingSince.delete(stream.peer.peerId);
      this.trustedPeerIds.add(stream.peer.peerId);
      this.maybeUnavailablePeerIds.delete(stream.peer.peerId);
      this.notifyUserList();
      if (this.callback.onConnect) this.callback.onConnect(stream.peer.peerId);
    });
    stream.on('close', () => {
      this.disconnectStream(stream);
    });
    stream.on('error', () => {
      this.disconnectStream(stream);
    });
    stream.on('stats', async () => {
      const health = stream.peer.session.health;
      const grade = stream.peer.session.grade;
      // health低下時に自動再接続（旧SkyWay版のロジックを復元）
      if (health < 0.35 || (grade < PeerSessionGrade.MIDDLE && health < 0.7)) {
        Logger.debug(`reconnecting... ${stream.peer.peerId} (health=${health.toFixed(2)}, grade=${grade})`);
        // 不安定通知を送信（チャット用）
        if (this.callback.onPeerUnstable) this.callback.onPeerUnstable(stream.peer.peerId, health);
        const peer = PeerContext.parse(stream.peer.peerId);
        peer.userId = stream.peer.userId;
        this.disconnectStream(stream);
        this.connect(peer);
      }
    });

    Promise.resolve().then(() => stream.connect()).catch(error => {
      Logger.error("SkyWay connect failed", error);
      this.disconnectStream(stream);
    });
  }

  private disconnectStream(stream: SkyWayDataStream) {
    // A late close from a replaced stream must not remove its replacement.
    let closed = this.streams.remove(stream);
    stream.disconnect();
    if (!closed) return;
    this.connectingSince.delete(stream.peer.peerId);
    this.maybeUnavailablePeerIds.delete(stream.peer.peerId);

    this.relayingPeerIds.delete(stream.peer.peerId);
    this.relayingPeerIds.forEach(peerIds => {
      let index = peerIds.indexOf(stream.peer.peerId);
      if (0 <= index) peerIds.splice(index, 1);
    });
    this.notifyUserList();
    if (closed && this.callback.onDisconnect) this.callback.onDisconnect(closed.peer.peerId);
  }

  private onData(stream: SkyWayDataStream, container: DataContainer) {
    if (container.peerIds) this.onUpdatePeerIds(stream, container.peerIds, container.senderUserId);
    if (0 < container.ttl) this.onRelay(stream, container);
    if (!this.callback.onData) return;
    let byteLength = container.data.byteLength;
    this.bandwidthUsage += byteLength;
    this.inboundQueue = this.inboundQueue.then(async () => {
      await new Promise<void>(resolve => setZeroTimeout(resolve));
      try {
        if (!this.callback.onData) return;
        let data = container.isCompressed ? await decompressAsync(container.data) : container.data;
        const decoded = data ? MessagePack.decode(data) : null;
        if (!Array.isArray(decoded)) throw new Error('Invalid SkyWay event batch');
        this.callback.onData(stream.peer.peerId, decoded);
      } finally {
        this.bandwidthUsage -= byteLength;
      }
    }).catch(error => Logger.error('SkyWay receive failed', error));
  }

  /** Recover missing room links without relying on gossip from an existing link. */
  private reconcileRoomMembers() {
    if (!this.skyWay.isOpen || !this.skyWay.room) return;
    const members = new Set(this.skyWay.room.members.map(member => member.name));
    for (const stream of this.streams) {
      const started = this.connectingSince.get(stream.peer.peerId);
      if (!members.has(stream.peer.peerId) ||
          (!stream.open && started != null && performance.now() - started >= 30000)) {
        this.disconnectStream(stream);
      }
    }
    for (const peerId of members) {
      if (peerId && peerId !== this.peerId && !this.streams.find(peerId)) this.connect(peerId);
    }
  }

  private onRelay(stream: SkyWayDataStream, container: DataContainer) {
    container.ttl--;

    let relayingPeerIds: string[] = this.relayingPeerIds.get(stream.peer.peerId);
    if (relayingPeerIds == null) return;

    if (container.users && 0 < container.users.length) {
      container.users = this.userIds;
      container.peerIds = this.peerIds.concat(this.peerId);
      container.senderUserId = this.peer.userId;
    }

    for (let peerId of relayingPeerIds) {
      let conn = this.streams.find(peerId);
      if (conn && conn.open) {
        Logger.debug('<' + peerId + '> 転送しなきゃ・・・');
        conn.send(container);
      }
    }
  }

  private onUpdatePeerIds(stream: SkyWayDataStream, peerIds: string[], userId?: string) {
    // Room peer IDs are random per session: never regenerate them from names.
    const changed = typeof userId === 'string' && stream.peer.userId !== userId;
    if (changed) stream.peer.userId = userId;
    this.relayingPeerIds.set(stream.peer.peerId,
      this.peerIds.filter(peerId => peerId !== stream.peer.peerId && !peerIds.includes(peerId)));
    if (changed) this.notifyUserList();
  }

  private notifyUserList() {
    this.streams.refresh();
    if (this.streams.length < 1) return;
    let container: DataContainer = {
      data: MessagePack.encode([]),
      users: this.userIds,
      peerIds: this.peerIds.concat(this.peerId),
      senderUserId: this.peer.userId,
      ttl: 1
    }
    this.sendBroadcast(container);
  }

}
