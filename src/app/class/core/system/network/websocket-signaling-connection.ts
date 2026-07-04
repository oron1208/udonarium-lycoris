import { compressAsync, decompressAsync } from '../util/compress';
import { MessagePack } from '../util/message-pack';
import { setZeroTimeout } from '../util/zero-timeout';
import { Connection, ConnectionCallback } from './connection';
import { PeerContext } from './peer-context';
import { PeerSessionGrade } from './peer-session-state';
import { SkyWayDataConnection } from './skyway-data-connection';
import { WebRtcSignalingDataConnection } from './webrtc-signaling-data-connection';
import { CandidateType } from './webrtc-stats';
import { Logger } from '../util/logger';

interface DataContainer {
  data: Uint8Array;
  peers?: string[];
  ttl: number;
  isCompressed?: boolean;
}

type SignalMessage =
  | { type: 'registered', id: string }
  | { type: 'peers', peers: string[] }
  | { type: 'offer', from: string, to: string, description: RTCSessionDescriptionInit, metadata?: any }
  | { type: 'answer', from: string, to: string, description: RTCSessionDescriptionInit }
  | { type: 'ice', from: string, to: string, candidate: RTCIceCandidateInit }
  | { type: 'unavailable', id: string }
  | { type: 'error', errorType?: string, message: string };

/**
 * SkyWay の Peer サーバ相当を、単純な WebSocket シグナリングサーバで置き換える Connection。
 * データ本体は従来通り WebRTC DataChannel(P2P)で流す。
 */
export class WebSocketSignalingConnection implements Connection {
  get peerId(): string { return this.peerContext ? this.peerContext.peerId : '???'; }

  private _peerIds: string[] = [];
  get peerIds(): string[] { return this._peerIds; }

  peerContext: PeerContext = PeerContext.parse('???');
  readonly peerContexts: PeerContext[] = [];
  readonly callback: ConnectionCallback = new ConnectionCallback();
  bandwidthUsage: number = 0;

  private signalingUrl = defaultSignalingUrl();
  private iceServers: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];
  private socket: WebSocket = null;
  private connections: SkyWayDataConnection[] = [];
  private pendingPeerConnections: Map<string, RTCPeerConnection> = new Map();

  private outboundQueue: Promise<any> = Promise.resolve();
  private inboundQueue: Promise<any> = Promise.resolve();
  private relayingPeerIds: Map<string, string[]> = new Map();
  private maybeUnavailablePeerIds: Set<string> = new Set();

  open(peerId: string)
  open(userId: string, roomId: string, roomName: string, password: string)
  open(...args: any[]) {
    if (args.length === 0) {
      this.peerContext = PeerContext.create(PeerContext.generateId());
    } else if (args.length === 1) {
      this.peerContext = PeerContext.create(args[0]);
    } else {
      this.peerContext = PeerContext.create(args[0], args[1], args[2], args[3]);
    }
    this.openSignalingSocket();
  }

  close() {
    if (this.socket) this.socket.close();
    this.disconnectAll();
    this.pendingPeerConnections.forEach(pc => pc.close());
    this.pendingPeerConnections.clear();
    this.socket = null;
    this.peerContext = PeerContext.parse('???');
  }

  connect(peerId: string): boolean {
    if (!this.shouldConnect(peerId)) return false;
    this.maybeUnavailablePeerIds.add(peerId);
    this.createOffer(peerId).catch(error => this.emitError(peerId, 'offer-error', error.message, error));
    return true;
  }

  disconnect(peerId: string): boolean {
    let conn = this.findDataConnection(peerId);
    if (!conn) return false;
    this.closeDataConnection(conn);
    return true;
  }

  disconnectAll() {
    for (let conn of this.connections.concat()) this.closeDataConnection(conn);
  }

  send(data: any, sendTo?: string) {
    if (this.connections.length < 1) return;
    let container: DataContainer = { data: MessagePack.encode(data), ttl: 1 };
    let byteLength = container.data.byteLength;
    this.bandwidthUsage += byteLength;
    this.outboundQueue = this.outboundQueue.then(() => new Promise<void>((resolve) => {
      setZeroTimeout(async () => {
        if (1 * 1024 < container.data.byteLength && Array.isArray(data) && 1 < data.length) {
          let compressed = await compressAsync(container.data);
          if (compressed.byteLength < container.data.byteLength) {
            container.data = compressed;
            container.isCompressed = true;
          }
        }
        sendTo ? this.sendUnicast(container, sendTo) : this.sendBroadcast(container);
        this.bandwidthUsage -= byteLength;
        resolve();
      });
    }));
  }

  setApiKey(key: string) { /* SkyWay互換: 未使用 */ }
  setSignalingUrl(url: string) { if (url) this.signalingUrl = url; }
  setIceServers(iceServers: RTCIceServer[]) { if (iceServers && iceServers.length) this.iceServers = iceServers; }

  listAllPeers(): Promise<string[]> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return Promise.resolve([]);
    return new Promise(resolve => {
      let handler = (event: MessageEvent) => {
        let message = JSON.parse(event.data) as SignalMessage;
        if (message.type !== 'peers') return;
        this.socket.removeEventListener('message', handler);
        resolve(message.peers);
      };
      this.socket.addEventListener('message', handler);
      this.sendSignal({ type: 'list' });
      setTimeout(() => {
        this.socket.removeEventListener('message', handler);
        resolve([]);
      }, 3000);
    });
  }

  private openSignalingSocket() {
    this.socket = new WebSocket(this.signalingUrl);
    this.socket.addEventListener('open', () => {
      this.sendSignal({ type: 'register', id: this.peerId });
    });
    this.socket.addEventListener('message', event => this.onSignalMessage(JSON.parse(event.data)));
    this.socket.addEventListener('close', () => {
      if (this.peerContext && this.peerContext.isOpen) {
        this.peerContext.isOpen = false;
        if (this.callback.onClose) this.callback.onClose(this.peerId);
      }
    });
    this.socket.addEventListener('error', event => this.emitError(this.peerId, 'socket-error', 'シグナリングサーバとの通信に失敗しました。', event));
  }

  private onSignalMessage(message: SignalMessage) {
    switch (message.type) {
      case 'registered':
        this.peerContext.isOpen = true;
        if (this.callback.onOpen) this.callback.onOpen(this.peerId);
        break;
      case 'peers':
        message.peers.forEach(peerId => {
          // The lobby needs a global peer list for room discovery, but automatic
          // WebRTC connection must stay within the current room to avoid cross-room mixing.
          if (this.shouldAutoConnectPeer(peerId) && !this._peerIds.includes(peerId) && !this.maybeUnavailablePeerIds.has(peerId)) this.connect(peerId);
        });
        break;
      case 'offer':
        this.acceptOffer(message).catch(error => this.emitError(message.from, 'answer-error', error.message, error));
        break;
      case 'answer':
        this.acceptAnswer(message).catch(error => this.emitError(message.from, 'answer-error', error.message, error));
        break;
      case 'ice':
        this.acceptIce(message).catch(error => this.emitError(message.from, 'ice-error', error.message, error));
        break;
      case 'unavailable':
        this.maybeUnavailablePeerIds.delete(message.id);
        this.disconnect(message.id);
        this.emitError(message.id, 'peer-unavailable', `Peer ${message.id} は利用できません。`, message);
        break;
      case 'error':
        this.emitError(this.peerId, message.errorType || 'server-error', message.message, message);
        break;
    }
  }

  private async createOffer(peerId: string) {
    let pc = this.createPeerConnection(peerId);
    let channel = pc.createDataChannel('udonarium', { ordered: true });
    this.openDataConnection(new SkyWayDataConnection(new WebRtcSignalingDataConnection(peerId, pc, channel, { sendFrom: this.peerId }) as any));
    let description = await pc.createOffer();
    await pc.setLocalDescription(description);
    this.sendSignal({ type: 'offer', to: peerId, description, metadata: { sendFrom: this.peerId } });
  }

  private async acceptOffer(message: Extract<SignalMessage, { type: 'offer' }>) {
    if (!this.shouldAcceptInbound(message.from)) return;
    let pc = this.createPeerConnection(message.from);
    pc.addEventListener('datachannel', event => {
      this.openDataConnection(new SkyWayDataConnection(new WebRtcSignalingDataConnection(message.from, pc, event.channel, message.metadata || { sendFrom: message.from }) as any));
    });
    await pc.setRemoteDescription(message.description);
    let description = await pc.createAnswer();
    await pc.setLocalDescription(description);
    this.sendSignal({ type: 'answer', to: message.from, description });
  }

  private async acceptAnswer(message: Extract<SignalMessage, { type: 'answer' }>) {
    let pc = this.pendingPeerConnections.get(message.from);
    if (!pc) return;
    await pc.setRemoteDescription(message.description);
  }

  private async acceptIce(message: Extract<SignalMessage, { type: 'ice' }>) {
    let pc = this.pendingPeerConnections.get(message.from);
    if (!pc || !message.candidate) return;
    await pc.addIceCandidate(message.candidate);
  }

  private createPeerConnection(peerId: string): RTCPeerConnection {
    let pc = new RTCPeerConnection({ iceServers: this.iceServers });
    this.pendingPeerConnections.set(peerId, pc);
    pc.addEventListener('icecandidate', event => {
      if (event.candidate) this.sendSignal({ type: 'ice', to: peerId, candidate: event.candidate.toJSON() });
    });
    return pc;
  }

  private shouldConnect(peerId: string): boolean {
    return !!(this.peerContext && this.socket && this.socket.readyState === WebSocket.OPEN && peerId && peerId !== this.peerId && !this.findDataConnection(peerId));
  }

  private shouldAcceptInbound(peerId: string): boolean {
    if (!peerId || peerId === this.peerId || !this.isSameRoomPeer(peerId)) return false;
    let existConn = this.findDataConnection(peerId);
    if (!existConn) return true;
    return peerId < this.peerId;
  }

  private shouldAutoConnectPeer(peerId: string): boolean {
    return !!(this.peerContext && this.peerContext.isRoom && this.isSameRoomPeer(peerId));
  }

  private isSameRoomPeer(peerId: string): boolean {
    if (!this.peerContext || !this.peerContext.isRoom) return false;
    let context = PeerContext.parse(peerId);
    return context.isRoom
      && context.roomId === this.peerContext.roomId
      && context.roomName === this.peerContext.roomName
      && context.digestPassword === this.peerContext.digestPassword;
  }

  private sendSignal(message: any) {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  private sendUnicast(container: DataContainer, sendTo: string) {
    container.ttl = 0;
    let conn = this.findDataConnection(sendTo);
    if (conn && conn.open) conn.send(container);
  }

  private sendBroadcast(container: DataContainer) {
    for (let conn of this.connections) if (conn.open) conn.send(container);
  }

  private openDataConnection(conn: SkyWayDataConnection) {
    if (this.addDataConnection(conn) === false) return;
    let index = this.connections.indexOf(conn);
    let context: PeerContext = null;
    if (0 <= index) context = this.peerContexts[index];
    this.maybeUnavailablePeerIds.add(conn.remoteId);
    conn.on('data', data => this.onData(conn, data));
    conn.on('open', () => {
      this.maybeUnavailablePeerIds.delete(conn.remoteId);
      if (context) context.isOpen = true;
      this.updatePeerList();
      if (this.callback.onConnect) this.callback.onConnect(conn.remoteId);
    });
    conn.on('close', () => this.closeDataConnection(conn));
    conn.on('error', () => this.closeDataConnection(conn));
    conn.on('stats', () => {
      let deltaTime = performance.now() - conn.timestamp;
      let healthRate = deltaTime <= 10000 ? 1 : 5000 / ((deltaTime - 10000) + 5000);
      let ping = healthRate < 1 ? deltaTime : conn.ping;
      let pingRate = 500 / (ping + 500);
      context.session.health = healthRate;
      context.session.ping = ping;
      context.session.speed = pingRate * healthRate;
      switch (conn.candidateType) {
        case CandidateType.HOST: context.session.grade = PeerSessionGrade.HIGH; break;
        case CandidateType.SRFLX:
        case CandidateType.PRFLX: context.session.grade = PeerSessionGrade.MIDDLE; break;
        case CandidateType.RELAY: context.session.grade = PeerSessionGrade.LOW; break;
        default: context.session.grade = PeerSessionGrade.UNSPECIFIED; break;
      }
      context.session.description = conn.candidateType;
      if (context.session.health < 0.2) this.closeDataConnection(conn);
    });
  }

  private closeDataConnection(conn: SkyWayDataConnection) {
    conn.close();
    let index = this.connections.indexOf(conn);
    if (0 <= index) {
      this.connections.splice(index, 1);
      this.peerContexts.splice(index, 1);
    }
    this.pendingPeerConnections.delete(conn.remoteId);
    this.relayingPeerIds.delete(conn.remoteId);
    this.relayingPeerIds.forEach(peerIds => {
      let index = peerIds.indexOf(conn.remoteId);
      if (0 <= index) peerIds.splice(index, 1);
    });
    this.updatePeerList();
    if (0 <= index && this.callback.onDisconnect) this.callback.onDisconnect(conn.remoteId);
  }

  private addDataConnection(conn: SkyWayDataConnection): boolean {
    let existConn = this.findDataConnection(conn.remoteId);
    if (existConn !== null) {
      if (existConn !== conn) {
        if (existConn.metadata.sendFrom < conn.metadata.sendFrom) {
          this.closeDataConnection(conn);
        } else {
          this.closeDataConnection(existConn);
          this.addDataConnection(conn);
          return true;
        }
      }
      return false;
    }
    this.connections.push(conn);
    this.peerContexts.push(PeerContext.parse(conn.remoteId));
    return true;
  }

  private findDataConnection(peerId: string): SkyWayDataConnection {
    for (let conn of this.connections) if (conn.remoteId === peerId) return conn;
    return null;
  }

  private onData(conn: SkyWayDataConnection, container: DataContainer) {
    if (container.peers && 0 < container.peers.length) this.onUpdatePeerList(conn, container);
    if (0 < container.ttl) this.onRelay(conn, container);
    if (this.callback.onData) {
      let byteLength = container.data.byteLength;
      this.bandwidthUsage += byteLength;
      this.inboundQueue = this.inboundQueue.then(() => new Promise<void>((resolve) => {
        setZeroTimeout(async () => {
          let data = container.isCompressed ? await decompressAsync(container.data) : container.data;
          this.callback.onData(conn.remoteId, MessagePack.decode(data));
          this.bandwidthUsage -= byteLength;
          resolve();
        });
      }));
    }
  }

  private onRelay(conn: SkyWayDataConnection, container: DataContainer) {
    container.ttl--;
    let relayingPeerIds = this.relayingPeerIds.get(conn.remoteId);
    if (relayingPeerIds == null) return;
    for (let peerId of relayingPeerIds) {
      let relayConn = this.findDataConnection(peerId);
      if (relayConn && relayConn.open) relayConn.send(container);
    }
  }

  private onUpdatePeerList(conn: SkyWayDataConnection, container: DataContainer) {
    let diff = diffArray(this._peerIds, container.peers);
    this.relayingPeerIds.set(conn.remoteId, diff.diff1);
    container.peers = container.peers.concat(diff.diff1);
    for (let peerId of diff.diff2) {
      if (!this.maybeUnavailablePeerIds.has(peerId) && this.connect(peerId)) Logger.debug('auto connect to unknown Peer <' + peerId + '>');
    }
  }

  private updatePeerList(): string[] {
    let peerIds: string[] = [];
    for (let conn of this.connections) if (conn.open) peerIds.push(conn.remoteId);
    peerIds.push(this.peerId);
    peerIds.sort();
    this._peerIds = peerIds;
    this.notifyPeerList();
    return peerIds;
  }

  private notifyPeerList() {
    if (this.connections.length < 1) return;
    let container: DataContainer = { data: MessagePack.encode([]), peers: this._peerIds, ttl: 1 };
    this.sendBroadcast(container);
  }

  private emitError(peerId: string, errorType: string, errorMessage: string, errorObject: any) {
    if (this.callback.onError) this.callback.onError(peerId, errorType, errorMessage, errorObject);
  }
}

function defaultSignalingUrl(): string {
  let protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${location.host}/signaling`;
}

function diffArray<T>(array1: T[], array2: T[]): { diff1: T[], diff2: T[] } {
  let diff1: T[] = [];
  let diff2: T[] = [];
  for (let item of array1.concat(array2)) {
    let includesInArray1 = array1.includes(item);
    let includesInArray2 = array2.includes(item);
    if (includesInArray1 && !includesInArray2) diff1.push(item);
    else if (!includesInArray1 && includesInArray2) diff2.push(item);
  }
  return { diff1, diff2 };
}
