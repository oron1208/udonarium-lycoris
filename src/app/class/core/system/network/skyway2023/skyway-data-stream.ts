import { LocalDataStream, P2PConnection, Publication, RemoteDataStream, RemoteMember, Subscription, TransportConnectionState } from '@skyway-sdk/core';
import { EventEmitter } from 'events';
import { MessagePack } from '../../util/message-pack';
import { UUID } from '../../util/uuid';
import { clearZeroTimeout, setZeroTimeout } from '../../util/zero-timeout';
import { IPeerContext, PeerContext } from '../peer-context';
import { PeerSessionGrade } from '../peer-session-state';
import { CandidateType, WebRTCStats } from '../webrtc/webrtc-stats';
import { WebRTCConnection, WebRTCStatsMonitor } from '../webrtc/webrtc-stats-monitor';
import { SkyWayFacade } from './skyway-facade';
import { Logger } from '../../util/logger';

interface Ping {
  from: string;
  ping: number;
};

interface DataChank {
  id: string;
  data: Uint8Array;
  index: number;
  total: number;
};

interface ReceivedChank {
  id: string;
  chanks: Uint8Array[];
  length: number;
  byteLength: number;
};

export class SkyWayDataStream extends EventEmitter implements WebRTCConnection {
  readonly peer: PeerContext;

  private chunkSize = 15.5 * 1024;
  private receivedMap: Map<string, ReceivedChank> = new Map();

  private stats!: WebRTCStats;

  /**
   * データ受信タイムアウト監視。
   * 一定時間データ受信がない場合、接続が死んでいると判断してcloseを発火する。
   * 旧SkyWay版(skyway-data-connection.ts)の15秒タイムアウトの復元。
   */
  private static readonly DATA_TIMEOUT_MS = 15000;
  private timeoutTimer: ReturnType<typeof setTimeout> | null = null;

  get open(): boolean { return this.peer.isOpen; }
  get member(): RemoteMember { return this.skyWay.room?.members.find(member => member.name === this.peer.peerId) as RemoteMember; }

  private isQueuing = false;
  private static readonly BUFFER_HIGH = 256 * 1024;
  private static readonly BUFFER_LOW = 64 * 1024;
  private static readonly SEND_BURST = 64 * 1024;
  private sendTask: number | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private sendFailures = 0;
  private onbufferedamountlow = () => {
    if (this.retryTimer != null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.scheduleSend();
  };
  private sendQueue: Set<Uint8Array> = new Set();

  private _timestamp: number = performance.now();
  get timestamp(): number { return this._timestamp; }
  private set timestamp(timestamp: number) { this._timestamp = timestamp };

  private _ping: number = 0;
  get ping(): number { return this._ping; }
  private set ping(ping: number) { this._ping = ping };

  private _candidateType: CandidateType = CandidateType.UNKNOWN;
  get candidateType(): CandidateType { return this._candidateType; }
  private set candidateType(candidateType: CandidateType) { this._candidateType = candidateType };

  sortKey = '';
  isPublication = false;
  private isCanceled = false;
  private isRejected = false;
  private isOpend = false;

  private state: TransportConnectionState = 'new';
  private subscription!: Subscription<RemoteDataStream>;
  private dataChannel!: RTCDataChannel;

  private onStreamAdded!: { removeListener: () => void };
  private onStreamPublished!: { removeListener: () => void };
  private onConnectionStateChanged!: { removeListener: () => void };

  private onopen = () => {
    Logger.debug(`peer ${this.peer.peerId} dataChannel is open`);
    this.refresh();
  }

  private onclose = () => { this.emit('close'); };

  private onmessage = (event: MessageEvent<any>) => {
    this.onData(event.data as ArrayBuffer);
  }

  /** データ受信タイムアウトタイマーを開始/リセット */
  private resetTimeoutTimer() {
    this.clearTimeoutTimer();
    this.timeoutTimer = setTimeout(() => {
      Logger.warn(`data timeout ${this.peer.peerId} (${SkyWayDataStream.DATA_TIMEOUT_MS}ms without receiving data)`);
      this.timeoutTimer = null;
      // タイムアウト発生 → 強制切断通知
      this.emit('close');
    }, SkyWayDataStream.DATA_TIMEOUT_MS);
  }

  /** データ受信タイムアウトタイマーをクリア */
  private clearTimeoutTimer() {
    if (this.timeoutTimer == null) return;
    clearTimeout(this.timeoutTimer);
    this.timeoutTimer = null;
  }

  private constructor(readonly skyWay: SkyWayFacade, peer: IPeerContext) {
    super();

    this.peer = PeerContext.parse(peer.peerId);
    this.peer.userId = peer.userId;
    this.peer.password = peer.password;
  }

  static createPublication(skyWay: SkyWayFacade, peer: IPeerContext): SkyWayDataStream {
    let instance = new SkyWayDataStream(skyWay, peer);
    instance.sortKey = instance.skyWay.peer.peerId;
    instance.isPublication = true;
    return instance;
  }

  static createSubscription(skyWay: SkyWayFacade, peer: IPeerContext): SkyWayDataStream {
    let instance = new SkyWayDataStream(skyWay, peer);
    instance.sortKey = instance.peer.peerId;
    instance.isPublication = false;
    return instance;
  }

  connect() {
    Logger.debug(`connect ${this.peer.peerId}, isPublication: ${this.isPublication}`);
    if (this.isPublication) {
      return this.initializePublication();
    } else {
      return this.initializeSubscription();
    }
  }

  disconnect() {
    Logger.debug(`disconnect ${this.peer.peerId}, isPublication: ${this.isPublication}`);
    this.isCanceled = true;
    this.dispose();
  }

  reject() {
    Logger.debug(`reject ${this.peer.peerId}, isPublication: ${this.isPublication}`);
    this.isRejected = true;
    this.connect();
  }

  private dispose() {
    Logger.debug(`dispose ${this.peer.peerId}, isPublication: ${this.isPublication}`);
    this.peer.isOpen = false;
    this.clearTimeoutTimer();
    this.stopMonitoring();
    this.removeAllListeners();

    this.onStreamAdded?.removeListener();
    this.onStreamPublished?.removeListener();
    this.onConnectionStateChanged?.removeListener();
    this.onStreamAdded = null;
    this.onStreamPublished = null;
    this.onConnectionStateChanged = null;

    const subscription = this.subscription;
    this.subscription = null;
    if (!this.isPublication && subscription && this.skyWay.roomPerson?.state !== 'left') {
      this.skyWay.roomPerson?.unsubscribe(subscription.id).catch(error => Logger.warn('unsubscribe failed', error));
    }
    if (this.sendTask != null) clearZeroTimeout(this.sendTask);
    if (this.retryTimer != null) clearTimeout(this.retryTimer);
    this.sendTask = null;
    this.retryTimer = null;
    this.isQueuing = false;
    this.sendQueue.clear();
    this.receivedMap.clear();

    this.dataChannel?.removeEventListener('open', this.onopen);
    this.dataChannel?.removeEventListener('message', this.onmessage);
    this.dataChannel?.removeEventListener('close', this.onclose);
    this.dataChannel?.removeEventListener('bufferedamountlow', this.onbufferedamountlow);
    this.dataChannel?.close();
    this.dataChannel = null;
  }

  private initializePublication() {
    if (this.isCanceled) return;
    //
    let member = this.member;
    let subscription = member?.subscriptions.find(subscription => subscription.publication.contentType === 'data'
      && subscription.publication.metadata === 'udonarium-data-stream'
      && subscription.publication.publisher.name === this.skyWay.peer.peerId) as Subscription<RemoteDataStream>;

    //
    if (!subscription) {
      Logger.error(`subscription is not found ${this.peer.peerId}`);
      this.emit('close');
      return;
    }

    //
    this.onConnectionStateChanged?.removeListener();
    this.onConnectionStateChanged = this.skyWay.publication.onConnectionStateChanged.add(event => {
      if (event.remoteMember.name !== this.peer.peerId) return;
      this.onStateChanged(event.state);
    });

    //
    Logger.debug(`initializePublication ${member.name} ${subscription.id}`);
    this.subscription = subscription;
    this.refresh();
  }

  private async initializeSubscription() {
    if (this.isCanceled) return;
    //
    let member = this.member;
    if (!member) { this.emit('close'); return; }
    let publication = member.publications.find(publication => publication.contentType === 'data' && publication.metadata === 'udonarium-data-stream');

    //
    if (!publication) {
      this.onStreamPublished?.removeListener();
      this.onStreamPublished = this.skyWay.room.onStreamPublished.add(event => {
        let isMatch = event.publication.contentType === 'data' && event.publication.metadata === 'udonarium-data-stream' && event.publication.publisher.name === this.peer.peerId;
        if (!isMatch) return;

        Logger.debug(`onStreamPublished: ${event.publication.publisher.name} <${event.publication.metadata}>`);
        this.onStreamPublished?.removeListener();
        this.initializeSubscription();
      });
      return;
    }

    //
    this.refresh();
    Logger.debug(`initializeSubscription ready ${member.name}`);
    try {
      let { subscription, stream } = await this.skyWay.roomPerson.subscribe<RemoteDataStream>(publication.id);

      if (this.isCanceled) {
        await this.skyWay.roomPerson.unsubscribe(subscription.id);
        return;
      }
      //
      this.onConnectionStateChanged?.removeListener();
      this.onConnectionStateChanged = subscription.onConnectionStateChanged.add(state => {
        this.onStateChanged(state);
      });

      //
      Logger.debug(`initializeSubscription done ${member.name} ${publication.id}`);
      this.subscription = subscription;

      this.refresh();
    } catch (e) {
      if (e instanceof Error) {
        Logger.debug(`${e.name}: ${e.message}`);
      } else {
        Logger.error(e);
      }

      this.state = 'disconnected';
      this.emit('close');
    }
  }

  private onStateChanged(state: TransportConnectionState) {
    Logger.debug(`onStateChanged isPublication: ${this.isPublication}, ${this.peer.peerId} ${this.state} -> ${state}`);
    switch (state) {
      case 'new': break;
      case 'connecting': break;
      case 'connected':
        if (this.state == 'reconnecting') this.peer.isOpen = false;
        break;
      case 'reconnecting': break;
      case 'disconnected':
        this.emit('close');
        return;
    }
    this.refresh();
    this.state = state;
  }

  private refresh() {
    if (this.isCanceled) return;
    // 現在のオブジェクトを取得
    let member = this.member;

    let p2pconnection = (member as any)?._getOrCreateConnection((this.skyWay.roomPerson as any)?._impl) as P2PConnection;
    let publication = member?.publications.find(publication => publication.metadata === 'udonarium-data-stream');

    let dataChannel = this.isPublication
      ? p2pconnection?.sender.datachannels[this.skyWay.publication?.id]
      : (p2pconnection?.receiver.streams[publication?.id] as RemoteDataStream)?._datachannel;

    // 接続状況確認
    let isOpen = dataChannel?.readyState === 'open';
    Logger.debug(`refresh ${member?.name}, isPublication: ${this.isPublication}, isOpen: ${isOpen}, dataChannel: ${dataChannel?.readyState}`);

    // cancelまたはrejectされているときは接続解除
    if (dataChannel && (this.isCanceled && isOpen || this.isRejected)) {
      dataChannel.close();
      this.dispose();
      this.state = 'disconnected';
      this.emit('close');
      return;
    }

    // RTCDataChannelを更新
    if (dataChannel && this.dataChannel && dataChannel !== this.dataChannel) {
      Logger.warn(`dataChannel is change: ${this.dataChannel?.id} -> ${dataChannel.id}`);
      this.peer.isOpen = false;
    }

    this.dataChannel?.removeEventListener('open', this.onopen);
    this.dataChannel?.removeEventListener('message', this.onmessage);
    this.dataChannel?.removeEventListener('close', this.onclose);
    this.dataChannel?.removeEventListener('bufferedamountlow', this.onbufferedamountlow);

    if (dataChannel) dataChannel.binaryType = 'arraybuffer';
    dataChannel?.addEventListener('open', this.onopen);
    dataChannel?.addEventListener('message', this.onmessage);
    dataChannel?.addEventListener('close', this.onclose);
    dataChannel?.addEventListener('bufferedamountlow', this.onbufferedamountlow);
    if (dataChannel) dataChannel.bufferedAmountLowThreshold = SkyWayDataStream.BUFFER_LOW;

    this.dataChannel = dataChannel;

    // P2PConnectionを更新
    Logger.debug(`p2pconnection: ${p2pconnection?.id}`);
    this.onStreamAdded?.removeListener();
    if (p2pconnection && !dataChannel) {
      this.onStreamAdded = p2pconnection?.receiver.onStreamAdded.add(event => {
        Logger.debug(`receiver.onStreamAdded: ${event.stream.id} ${(event.stream as RemoteDataStream)?._datachannel?.readyState}`);
        this.refresh();
      });
    }

    // open or close
    if (isOpen !== this.peer.isOpen) {
      this.peer.isOpen = isOpen;
      if (isOpen) {
        this.isOpend = true;
        this.timestamp = performance.now();
        this.state = 'connected';
        this.resetTimeoutTimer();
        this.emit('open');
      } else {
        this.clearTimeoutTimer();
        this.state = 'disconnected';
        this.emit('close');
      }
    }

    // モニタリング制御
    let peerConnection = this.getPeerConnection();
    this.stats = peerConnection ? new WebRTCStats(peerConnection) : null;

    if (isOpen) {
      this.startMonitoring();
      this.scheduleSend();
    } else {
      this.stopMonitoring();
    }
  }

  send(data: any) {
    let encodedData: Uint8Array = MessagePack.encode(data);

    let total = Math.ceil(encodedData.byteLength / this.chunkSize);
    if (total <= 1) {
      this.addSendQueue(encodedData);
      return;
    }

    let id = UUID.generateUuid();

    let sliceData: Uint8Array = null;
    let chank: DataChank = null;
    for (let sliceIndex = 0; sliceIndex < total; sliceIndex++) {
      sliceData = encodedData.slice(sliceIndex * this.chunkSize, (sliceIndex + 1) * this.chunkSize);
      chank = { id: id, data: sliceData, index: sliceIndex, total: total };
      this.addSendQueue(MessagePack.encode(chank));
    }
  }

  private addSendQueue(data: Uint8Array) {
    if (this.isCanceled || !data) return;
    this.sendQueue.add(data);
    this.scheduleSend();
  }

  private scheduleSend() {
    if (this.isCanceled || this.sendTask != null || this.retryTimer != null || !this.sendQueue.size) return;
    this.isQueuing = true;
    this.sendTask = setZeroTimeout(this.execQueue);
  }

  private execQueue = () => {
    this.sendTask = null;
    this.isQueuing = false;
    if (this.isCanceled || this.dataChannel?.readyState !== 'open') return;
    let sent = 0;
    for (const data of this.sendQueue) {
      // Wait for bufferedamountlow instead of flooding the browser's SCTP queue.
      if (this.dataChannel.bufferedAmount + data.byteLength > SkyWayDataStream.BUFFER_HIGH) return;
      try {
        this.dataChannel.send(data);
        this.sendQueue.delete(data);
        this.sendFailures = 0;
        sent += data.byteLength;
      } catch (error) {
        // OperationError may be temporary browser buffer pressure. Retry at a
        // bounded rate, never in a zero-timeout CPU/logging loop.
        if (error?.name === 'OperationError' && ++this.sendFailures <= 5) {
          this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            this.scheduleSend();
          }, 100);
        } else {
          Logger.warn('Data channel send failed; reconnecting', error);
          this.emit('close');
        }
        return;
      }
      if (sent >= SkyWayDataStream.SEND_BURST) break;
    }
    this.scheduleSend();
  }

  getPeerConnection(): RTCPeerConnection {
    if (this.isPublication) {
      return (this.subscription?.publication as Publication<LocalDataStream>)?.stream?._getRTCPeerConnection(this.member);
    } else {
      return this.subscription?.stream?._getRTCPeerConnection();
    }
  }

  private startMonitoring() {
    WebRTCStatsMonitor.add(this);
  }

  private stopMonitoring() {
    WebRTCStatsMonitor.remove(this);
  }

  async updateStatsAsync() {
    if (this.stats == null) return;
    await this.stats.updateAsync();
    if (this.isCanceled) return;
    this.candidateType = this.stats.candidateType;

    let deltaTime = performance.now() - this.timestamp;
    let healthRate = deltaTime <= 10000 ? 1 : 5000 / ((deltaTime - 10000) + 5000);
    let ping = healthRate < 1 ? deltaTime : this.ping;
    let pingRate = 500 / (ping + 500);

    this.peer.session.health = healthRate;
    this.peer.session.ping = ping;
    this.peer.session.speed = pingRate * healthRate;

    switch (this.candidateType) {
      case CandidateType.HOST:
        this.peer.session.grade = PeerSessionGrade.HIGH;
        break;
      case CandidateType.SRFLX:
      case CandidateType.PRFLX:
        this.peer.session.grade = PeerSessionGrade.MIDDLE;
        break;
      case CandidateType.RELAY:
        this.peer.session.grade = PeerSessionGrade.LOW;
        break;
      default:
        this.peer.session.grade = PeerSessionGrade.UNSPECIFIED;
        break;
    }
    this.peer.session.description = this.candidateType;

    this.emit('stats', this.stats);
  }

  sendPing() {
    let encodedData: Uint8Array = MessagePack.encode({ from: this.skyWay.peer.peerId, ping: performance.now() });
    this.addSendQueue(encodedData);
  }

  private receivePing(ping: Ping) {
    if (ping.from === this.skyWay.peer.peerId) {
      let now = performance.now();
      let rtt = now - ping.ping;
      this.ping = rtt <= this.ping ? (this.ping * 0.5) + (rtt * 0.5) : rtt;
    } else {
      let encodedData = MessagePack.encode(ping);
      this.addSendQueue(encodedData);
    }
  }

  private onData(data: ArrayBuffer) {
    this.timestamp = performance.now();
    this.resetTimeoutTimer();
    let decoded: unknown = MessagePack.decode(new Uint8Array(data));

    let ping: Ping = decoded as Ping;
    if (ping.ping != null) {
      this.receivePing(ping);
      return;
    }

    let chank: DataChank = decoded as DataChank;
    if (chank.id == null) {
      this.emit('data', decoded);
      return;
    }

    let received = this.receivedMap.get(chank.id);
    if (received == null) {
      received = { id: chank.id, chanks: new Array(chank.total), length: 0, byteLength: 0 };
      this.receivedMap.set(chank.id, received);
    }

    if (received.chanks[chank.index] != null) return;

    received.length++;
    received.byteLength += chank.data.byteLength;
    received.chanks[chank.index] = chank.data;

    if (received.length < chank.total) return;
    this.receivedMap.delete(chank.id);

    let uint8Array = new Uint8Array(received.byteLength);

    let pos = 0;
    for (let c of received.chanks) {
      uint8Array.set(c, pos);
      pos += c.byteLength;
    }

    let decodedChank = MessagePack.decode(uint8Array);
    this.emit('data', decodedChank);
  }
}
