import { compressAsync, decompressAsync } from '../util/compress';
import { MessagePack } from '../util/message-pack';
import { setZeroTimeout } from '../util/zero-timeout';
import { EventSystem } from '..';
import { ObjectContext } from '../../synchronize-object/game-object';
import { ObjectStore } from '../../synchronize-object/object-store';
import { reconcileChatTabsFromSnapshot } from '../../synchronize-object/room-snapshot-reconciler';
import { Connection, ConnectionCallback } from './connection';
import { PeerContext } from './peer-context';
import { defaultSignalingUrl } from './room-beacon';
import { PeerSessionGrade } from './peer-session-state';
import { Logger } from '../util/logger';

// How often a relay client asks the server for an answer.
const RELAY_HEARTBEAT_MS = 20000;

interface RelayDataContainer {
  data: Uint8Array;
  isCompressed?: boolean;
}

type EncodedContainer = { data: string, isCompressed?: boolean };
type StoredRelayEvent = { seq: number, from: string, to?: string, container: EncodedContainer };
type RoomSnapshot = { at?: number, from?: string, data?: { objects: ObjectContext[] } };
type RelayMessage =
  | { type: 'registered', id: string, transport?: string, p2pAvailable?: boolean }
  | { type: 'ack', seq: number }
  | { type: 'pong', t?: number }
  | { type: 'peers', peers: string[], transports?: { [peerId: string]: string } }
  | { type: 'room-snapshot', roomKey: string, seq: number, snapshotSeq?: number, snapshot?: RoomSnapshot, events: StoredRelayEvent[], deleted?: string[], resync?: string }
  | { type: 'snapshot-ack', seq: number, snapshotSeq: number }
  | { type: 'snapshot-rejected', seq: number, snapshotSeq: number, reason?: string, objects?: number, previousObjects?: number }
  | { type: 'relay-data', seq?: number, from: string, to?: string, container: EncodedContainer }
  | { type: 'developer-announcement', text: string, level?: string, startsAt?: string, createdAt?: string }
  | { type: 'developer-announcement-clear', clear: boolean, createdAt?: string }
  | { type: 'snapshot-save-request', roomKey: string, seq: number }
  | { type: 'resync-request', from?: string }
  | { type: 'unavailable', id: string }
  | { type: 'error', errorType?: string, message: string, transport?: string };

/**
 * Central-server mode.
 *
 * Browser clients connect only to the self-hosted WebSocket server. Game events are
 * relayed and persisted by the server, avoiding WebRTC/SkyWay/NAT issues and allowing
 * reconnect/replay for small private tables.
 */
export class WebSocketRelayConnection implements Connection {
  get peerId(): string { return this.peerContext ? this.peerContext.peerId : '???'; }
  get peerIds(): string[] { return this._peerIds.concat(); }

  peerContext: PeerContext = PeerContext.parse('???');
  readonly peerContexts: PeerContext[] = [];
  readonly callback: ConnectionCallback = new ConnectionCallback();
  bandwidthUsage: number = 0;

  private signalingUrl = defaultSignalingUrl();
  private socket: WebSocket = null;
  private _peerIds: string[] = [];
  /** How the server registered this socket: 'relay', or 'p2p' for a member that only announces a P2P room. */
  transport = 'relay';
  /** Whether the server issues SkyWay tokens, which a new room needs in order to choose P2P. */
  p2pAvailable = false;
  /** The listed members of rooms that are carried by P2P. */
  p2pPeerIds: string[] = [];
  private outboundQueue: Promise<any> = Promise.resolve();
  private inboundQueue: Promise<any> = Promise.resolve();
  private intentionalClose = false;
  private reconnectTimer: any = null;
  private reconnectAttempt = 0;
  private lastSeq = 0;
  private snapshotTimer: any = null;
  private snapshotSaveTimer: any = null;
  private snapshotSaveDueAt = 0;
  private snapshotDirtyAt = 0;
  private forceSnapshotApply = false;
  private bundleDownloaded = false;
  private roomEpoch = 0;
  private snapshotApplying = false;
  private heartbeatTimer: any = null;
  private lastPongAt = 0;
  private pongSeen = false;
  private callbackOnline = () => this.reconnectNow();
  open(peerId: string)
  open(userId: string, roomId: string, roomName: string, password: string)
  open(...args: any[]) {
    this.roomEpoch++;
    this.bundleDownloaded = false;
    this.snapshotApplying = false;
    this.intentionalClose = false;
    this.clearReconnectTimer();
    if (args.length === 0) {
      this.peerContext = PeerContext.create(PeerContext.generateId());
    } else if (args.length === 1) {
      this.peerContext = PeerContext.create(args[0]);
    } else {
      this.peerContext = PeerContext.create(args[0], args[1], args[2], args[3]);
    }
    this.lastSeq = 0;
    window.addEventListener('online', this.callbackOnline, false);
    this.openSocket();
  }

  close() {
    this.roomEpoch++;
    this.snapshotApplying = false;
    this.intentionalClose = true;
    this.clearReconnectTimer();
    this.stopSnapshotTimer();
    this.stopHeartbeat();
    window.removeEventListener('online', this.callbackOnline, false);
    if (this.socket) this.socket.close();
    this.socket = null;
    this.setPeers([]);
    this.peerContext = PeerContext.parse('???');
  }

  connect(peerId: string): boolean {
    return this.peerIds.includes(peerId);
  }

  disconnect(peerId: string): boolean {
    return this.peerIds.includes(peerId);
  }

  disconnectAll() { this.setPeers([]); }

  send(data: any, sendTo?: string) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN || !this.peerContext.isRoom) return;
    let container: RelayDataContainer = { data: MessagePack.encode(data) };
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
        this.sendRelayData(container, sendTo);
        this.scheduleSnapshotSave();
        this.bandwidthUsage -= byteLength;
        resolve();
      });
    }));
  }

  setApiKey(key: string) { /* unused */ }
  setSignalingUrl(url: string) { if (url) this.signalingUrl = url; }
  setIceServers(iceServers: RTCIceServer[]) { /* unused */ }

  listAllPeers(): Promise<string[]> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return Promise.resolve([]);
    return new Promise(resolve => {
      let handler = (event: MessageEvent) => {
        let message = JSON.parse(event.data) as RelayMessage;
        if (message.type !== 'peers') return;
        this.socket.removeEventListener('message', handler);
        resolve(message.peers);
      };
      this.socket.addEventListener('message', handler);
      this.sendSignal({ type: 'list' });
      setTimeout(() => {
        // 入室等でsocketが再接続中(null)にタイムアウトが発火しても落とさない
        if (this.socket) this.socket.removeEventListener('message', handler);
        resolve([]);
      }, 3000);
    });
  }

  forceResync(): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN || !this.peerContext.isRoom) return false;
    this.forceSnapshotApply = true;
    this.sendSignal({ type: 'resync-request' });
    setTimeout(() => {
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN || !this.peerContext.isRoom) return;
      this.sendSignal({ type: 'sync-request', sinceSeq: 0 });
    }, 2000);
    return true;
  }

  private openSocket() {
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) return;
    const socket = new WebSocket(this.signalingUrl);
    this.socket = socket;
    socket.addEventListener('open', () => {
      if (this.socket !== socket) return;
      this.reconnectAttempt = 0;
      this.sendSignal({ type: 'register', id: this.peerId, mode: 'relay', sinceSeq: this.lastSeq });
    });
    socket.addEventListener('message', event => {
      if (this.socket !== socket) return;
      try {
        this.onMessage(JSON.parse(event.data));
      } catch (error) {
        Logger.warn('Relay message could not be processed', error);
      }
    });
    socket.addEventListener('close', () => {
      if (this.socket !== socket) return;
      if (this.peerContext && this.peerContext.isOpen) {
        this.peerContext.isOpen = false;
        if (this.callback.onClose) this.callback.onClose(this.peerId);
      }
      this.setPeers([]);
      this.socket = null;
      if (!this.intentionalClose) this.scheduleReconnect();
    });
    socket.addEventListener('error', event => {
      if (this.socket !== socket) return;
      this.emitError(this.peerId, 'socket-error', '中央サーバーとの通信に失敗しました。再接続を試みます。', event);
    });
  }

  private scheduleReconnect() {
    this.clearReconnectTimer();
    if (!this.peerContext || this.peerId === '???') return;
    let delay = Math.min(30000, 1000 * Math.pow(1.6, this.reconnectAttempt++));
    this.reconnectTimer = setTimeout(() => this.openSocket(), delay);
  }

  private clearReconnectTimer() {
    if (this.reconnectTimer == null) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private onMessage(message: RelayMessage) {
    // Anything the server still sends proves the socket is alive; a pong also proves it answers pings.
    this.lastPongAt = Date.now();
    if (message.type === 'pong') this.pongSeen = true;
    switch (message.type) {
      case 'registered':
        this.transport = message.transport || 'relay';
        this.p2pAvailable = !!message.p2pAvailable;
        this.peerContext.isOpen = true;
        if (this.callback.onOpen) this.callback.onOpen(this.peerId);
        this.startSnapshotTimer();
        this.startHeartbeat();
        break;
      case 'ack':
        this.advanceCursorAfterInbound(message.seq || 0);
        break;
      case 'snapshot-ack':
        this.advanceCursorAfterInbound(message.snapshotSeq || message.seq || 0);
        break;
      case 'snapshot-rejected':
        Logger.warn(`snapshot rejected: ${message.reason || 'unknown'} objects=${message.objects || 0} previous=${message.previousObjects || 0}`);
        this.lastSeq = Math.min(this.lastSeq, message.snapshotSeq || message.seq || this.lastSeq);
        this.forceSnapshotApply = true;
        this.sendSignal({ type: 'sync-request', sinceSeq: 0 });
        break;
      case 'snapshot-save-request':
        Logger.debug(`server requested snapshot save, seq=${message.seq}`);
        this.scheduleSnapshotSave(1000);
        break;
      case 'peers':
        this.p2pPeerIds = Object.keys(message.transports || {});
        this.setPeers(message.peers.filter(peerId => peerId !== this.peerId && this.isSameRoomPeer(peerId) && !message.transports?.[peerId]));
        break;
      case 'room-snapshot':
        // A cursor inside the trimmed log: the snapshot is older than this client's cursor but is its base again.
        if (message.resync === 'gap') this.forceSnapshotApply = true;
        this.receiveSnapshot(message.events || [], message.seq || 0, message.snapshot, message.snapshotSeq || 0, message.roomKey, message.deleted || []);
        break;
      case 'relay-data':
        this.receiveRelayData(message.from, message.container, message.seq || 0);
        break;
      case 'resync-request':
        this.scheduleSnapshotSave(500);
        break;
      case 'developer-announcement':
        EventSystem.trigger('DEVELOPER_ANNOUNCEMENT', message);
        break;
      case 'developer-announcement-clear':
        EventSystem.trigger('DEVELOPER_ANNOUNCEMENT', message);
        break;
      case 'unavailable':
        this.emitError(message.id, 'peer-unavailable', `Peer ${message.id} は利用できません。`, message);
        break;
      case 'pong': break;
      case 'error':
        this.emitError(this.peerId, message.errorType || 'server-error', message.message, message);
        break;
    }
  }

  private async receiveSnapshot(events: StoredRelayEvent[], serverSeq: number, snapshot?: RoomSnapshot, snapshotSeq: number = 0, roomKey?: string, deleted: string[] = []) {
    const epoch = this.roomEpoch;
    const current = () => this.roomEpoch === epoch;
    const syncId = `relay-state-${epoch}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    this.inboundQueue = this.inboundQueue.catch(error => Logger.warn('Previous relay receive failed', error)).then(async () => {
      if (!current()) return;
      this.snapshotApplying = true;
      try {
        if (snapshot?.data?.objects && (snapshotSeq > this.lastSeq || this.forceSnapshotApply)) {
          await this.applyObjectSnapshot(snapshot.data.objects, snapshot.from || 'server-snapshot', syncId, current);
          if (!current()) return;
          // Forced restores must replay from the included snapshot, not our old cursor.
          // Otherwise imported tabs/messages removed by reconciliation never return.
          this.lastSeq = this.forceSnapshotApply ? snapshotSeq || 0 : Math.max(this.lastSeq, snapshotSeq || 0);
          this.forceSnapshotApply = false;
        }
        let replayedEvents = 0;
        for (const event of events) {
          if (!current()) return;
          if (event.seq <= this.lastSeq) continue;
          await this.decodeAndDispatch(event.from, event.container, event.seq, current);
          replayedEvents++;
        }
        if (!current()) return;
        this.forgetDeleted(deleted);
        this.lastSeq = Math.max(this.lastSeq, serverSeq || 0);
        if (replayedEvents > 0) this.scheduleSnapshotSave(5000);
        // Metadata and ordered replay are the interaction barrier; media is not.
        EventSystem.trigger('INITIAL_ROOM_SYNC_PROGRESS', { syncId, phase: 'complete', total: 0, done: 0 });
        if (snapshot?.data?.objects && roomKey && !this.bundleDownloaded) {
          this.bundleDownloaded = true;
          void this.downloadMediaBundle(snapshot.data.objects, roomKey, current);
        }
      } catch (error) {
        EventSystem.trigger('INITIAL_ROOM_SYNC_PROGRESS', { syncId, phase: 'failed', total: 0, done: 0 });
        this.emitError(this.peerId, 'snapshot-apply-failed', '部屋データを反映できませんでした。再同期してください。', error);
      } finally {
        if (current()) this.snapshotApplying = false;
        else EventSystem.trigger('INITIAL_ROOM_SYNC_PROGRESS', { syncId, phase: 'fallback', total: 0, done: 0 });
      }
    });
  }

  // Objects deleted while this client was away, after the deletion had left the event log. The snapshot
  // only adds and updates, so a client that resumes on the relay alone (no other member hands over a room
  // bundle) would keep them for good. Nothing is sent: the deletion is already on record.
  private forgetDeleted(identifiers: string[]) {
    if (!Array.isArray(identifiers) || identifiers.length < 1) return;
    let forgotten = 0;
    const forget = (object: any) => {
      if (!object) return;
      for (const child of Array.from(object.children || [])) forget(child);
      ObjectStore.instance.remove(object);
      forgotten++;
    };
    for (const identifier of identifiers) forget(ObjectStore.instance.get(identifier));
    if (0 < forgotten) Logger.debug(`[relay] removed ${forgotten} object(s) deleted while this client was away`);
  }

  // The socket can stay "open" while nothing passes any more, after sleep or a change of network. Every
  // message proves it alive and the server answers pings; silence for two and a half intervals closes the
  // socket, and the usual reconnect brings the room back. A server that has not answered a single ping (an
  // older one) is not judged by silence.
  private startHeartbeat() {
    this.stopHeartbeat();
    if (!this.peerContext || !this.peerContext.isRoom) return;
    this.lastPongAt = Date.now();
    this.heartbeatTimer = setInterval(() => this.checkHeartbeat(), RELAY_HEARTBEAT_MS);
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer != null) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private checkHeartbeat() {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    if (!this.pongSeen || Date.now() - this.lastPongAt <= RELAY_HEARTBEAT_MS * 2.5) {
      this.sendSignal({ type: 'ping', t: Date.now() });
      return;
    }
    Logger.warn('[relay] no answer from the server for a while; reconnecting');
    this.socket = null;
    this.stopHeartbeat();
    try { socket.close(); } catch (error) { /* already dead */ }
    if (this.peerContext && this.peerContext.isOpen) {
      this.peerContext.isOpen = false;
      if (this.callback.onClose) this.callback.onClose(this.peerId);
    }
    this.setPeers([]);
    if (!this.intentionalClose) this.scheduleReconnect();
  }

  // The network is back and the socket is gone: do not wait for the reconnect timer.
  private reconnectNow() {
    if (this.intentionalClose || !this.peerContext || this.peerId === '???') return;
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) return;
    this.clearReconnectTimer();
    this.openSocket();
  }

  private createObjectSnapshot(): { objects: ObjectContext[] } {
    // Personal notices ('your connection with X was confirmed', 'X logged out') are made by each client
    // for itself and shown to it alone. They belong to no room state: leaving them out keeps them from
    // reaching other members and whoever joins next through a snapshot.
    return {
      objects: ObjectStore.instance.getObjects()
        .filter(object => !(object as any).tags?.includes?.('to-pl-system-message'))
        .map(object => object.toContext())
    };
  }

  /** Background, cache-first individual media reads share the normal bounded fetch queue. */
  private async downloadMediaBundle(objects: ObjectContext[], _roomKey: string, current: () => boolean): Promise<void> {
    const operationId = `relay-room-media-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    let total = 0, done = 0;
    const progress = (status: string) => EventSystem.trigger('MEDIA_BUNDLE_PROGRESS', {
      operationId, status, total, done, background: true,
    });
    try {
      const [{ MediaCache }, { MediaLoadPriority }, { ImageStorage }, { AudioStorage }, { ImageState }] = await Promise.all([
        import('../../file-storage/media-cache'), import('../../file-storage/media-load-priority'),
        import('../../file-storage/image-storage'), import('../../file-storage/audio-storage'), import('../../file-storage/image-file'),
      ]);
      if (!current()) return;
      const { images, audios } = this.collectRoomMediaIdentifiers(objects);
      const unheld = await this.filterUnheldMediaIdentifiers(images, audios);
      if (!current()) return;
      const imageScores = MediaLoadPriority.getImageScoreMap(), audioScores = MediaLoadPriority.getAudioScoreMap();
      const work = [
        ...unheld.images.map(identifier => ({ kind: 'image', identifier, score: imageScores.get(identifier) || 0 })),
        ...unheld.audios.map(identifier => ({ kind: 'audio', identifier, score: audioScores.get(identifier) || 0 })),
      ].sort((a, b) => b.score - a.score);
      total = work.length;
      if (!total) return;
      progress('downloading');
      let next = 0;
      const consume = async () => {
        while (current() && next < work.length) {
          const item = work[next++];
          const priority = MediaLoadPriority.fetchPriority(item.score, 80);
          try {
            if (item.kind === 'image') {
              const held = ImageStorage.instance.peek(item.identifier);
              if (!held?.blob || held.state < ImageState.COMPLETE) {
                const result = await MediaCache.fetchImageWithCache(item.identifier, priority);
                if (current() && result.status === 'ok') ImageStorage.instance.add(result.file);
              }
            } else {
              if (!AudioStorage.instance.peek(item.identifier)?.blob) {
                const result = await MediaCache.fetchAudioWithCache(item.identifier, priority);
                if (current() && result.status === 'ok') AudioStorage.instance.add(result.file);
              }
            }
          } catch (error) { Logger.warn('Background media unavailable', item.identifier, error); }
          done++;
          if (current()) progress('downloading');
        }
      };
      // Two background consumers leave room for directly requested foreground assets.
      await Promise.all([consume(), consume()]);
    } catch (error) { Logger.warn('Background room media unavailable', error); }
    finally { progress('done'); }
  }

  /** 部屋オブジェクトから参照されているメディア（SHA-256識別子）を収集する */
  private collectRoomMediaIdentifiers(objects: ObjectContext[]): { images: string[]; audios: string[] } {
    const images = new Set<string>();
    const audios = new Set<string>();
    const hashPattern = /^[a-f0-9]{64}$/i;
    const visit = (value: any, depth: number): void => {
      if (value == null || depth > 8) return;
      if (Array.isArray(value)) {
        for (const item of value) visit(item, depth + 1);
        return;
      }
      if (typeof value !== 'object') return;
      const imageId = (value as any).imageIdentifier;
      if (typeof imageId === 'string' && hashPattern.test(imageId)) images.add(imageId);
      const backgroundId = (value as any).backgroundImageIdentifier;
      if (typeof backgroundId === 'string' && hashPattern.test(backgroundId)) images.add(backgroundId);
      const audioId = (value as any).audioIdentifier;
      if (typeof audioId === 'string' && hashPattern.test(audioId)) audios.add(audioId);
      // Character portraits are child DataElements, not a field on the character itself.
      const type = (value as any).type || (value as any).attributes?.type;
      const resource = (value as any).value;
      if (typeof resource === 'string' && hashPattern.test(resource)) {
        if (type === 'image') images.add(resource);
        if (type === 'audio') audios.add(resource);
      }
      for (const key in value) {
        try {
          visit((value as any)[key], depth + 1);
        } catch { /* 循環参照などは無視 */ }
      }
    };
    for (const object of objects) visit(object, 0);
    return { images: Array.from(images), audios: Array.from(audios) };
  }

  /** ローカルにblob完全所持のメディアは取得対象から除外する（再入室時の無駄転送防止） */
  private async filterUnheldMediaIdentifiers(images: string[], audios: string[]): Promise<{ images: string[]; audios: string[] }> {
    const [{ ImageStorage }, { AudioStorage }, { ImageState }] = await Promise.all([
      import('../../file-storage/image-storage'),
      import('../../file-storage/audio-storage'),
      import('../../file-storage/image-file'),
    ]);
    const heldImages = new Set<string>();
    for (const image of ImageStorage.instance.images) {
      if (image?.identifier && image.blob && ImageState.COMPLETE <= image.state && image.state < ImageState.URL) heldImages.add(image.identifier);
    }
    const heldAudios = new Set<string>();
    for (const audio of AudioStorage.instance.audios) {
      if (audio?.identifier && audio.blob) heldAudios.add(audio.identifier);
    }
    return { images: images.filter(identifier => !heldImages.has(identifier)), audios: audios.filter(identifier => !heldAudios.has(identifier)) };
  }

  private async applyObjectSnapshot(objects: ObjectContext[], sendFrom: string, syncId: string, current: () => boolean) {
    // Prioritize chat logs and core table objects so players see conversation
    // history and the game board first when joining a large room.
    const priorityOrder: Record<string, number> = {
      'chat-tab-list': 0,
      'chat-tab': 1,
      'chat': 2,
      'game-table': 3,
      'PeerCursor': 4,
      'character': 5,
      'character-group': 6,
    };
    const sorted = objects.slice().sort((a, b) => {
      const pa = priorityOrder[a.aliasName] ?? 99;
      const pb = priorityOrder[b.aliasName] ?? 99;
      return pa - pb;
    });

    const batchSize = 100;
    let processed = 0;
    EventSystem.trigger('INITIAL_ROOM_SYNC_PROGRESS', {
      syncId,
      phase: 'applying',
      total: sorted.length,
      done: 0
    });
    try {
      for (let context of sorted) {
        if (!current()) return;
        processed++;
        if (context && context.identifier && !ObjectStore.instance.isDeleted(context.identifier)) {
          EventSystem.trigger({ eventName: 'UPDATE_GAME_OBJECT', data: context, sendFrom });
        }
        // Large rooms can have 2000+ objects. Yield between batches so the browser
        // can paint/process input and avoid appearing frozen during snapshot apply.
        if (processed % batchSize === 0) {
          EventSystem.trigger('INITIAL_ROOM_SYNC_PROGRESS', {
            syncId,
            phase: 'applying',
            total: sorted.length,
            done: processed
          });
          await new Promise<void>(resolve => setTimeout(resolve, 0));
        }
      }
      reconcileChatTabsFromSnapshot(sorted);
    } catch (error) {
      EventSystem.trigger('INITIAL_ROOM_SYNC_PROGRESS', {
        syncId,
        phase: 'failed',
        total: sorted.length,
        done: processed
      });
      throw error;
    }
  }

  private startSnapshotTimer() {
    this.stopSnapshotTimer();
    if (!this.peerContext || !this.peerContext.isRoom) return;
    this.snapshotTimer = setInterval(() => this.saveSnapshot(), 5 * 60 * 1000);
  }

  private stopSnapshotTimer() {
    if (this.snapshotTimer != null) clearInterval(this.snapshotTimer);
    if (this.snapshotSaveTimer != null) clearTimeout(this.snapshotSaveTimer);
    this.snapshotTimer = null;
    this.snapshotSaveTimer = null;
    this.snapshotSaveDueAt = 0;
    this.snapshotDirtyAt = 0;
  }

  private scheduleSnapshotSave(delayMs: number = 30000) {
    if (!this.peerContext || !this.peerContext.isRoom) return;
    const now = Date.now();
    if (!this.snapshotDirtyAt) this.snapshotDirtyAt = now;
    const maxWaitMs = 60000;
    const dueAt = Math.min(now + delayMs, this.snapshotDirtyAt + maxWaitMs);
    if (this.snapshotSaveTimer != null && this.snapshotSaveDueAt <= dueAt) return;
    if (this.snapshotSaveTimer != null) clearTimeout(this.snapshotSaveTimer);
    this.snapshotSaveDueAt = dueAt;
    this.snapshotSaveTimer = setTimeout(() => this.saveSnapshot(), Math.max(0, dueAt - now));
  }

  /** 手動スナップショット保存（UIボタンから呼び出し可能） */
  manualSaveSnapshot(): boolean {
    if (this.snapshotApplying || !this.socket || this.socket.readyState !== WebSocket.OPEN || !this.peerContext.isRoom) return false;
    this.saveSnapshot();
    return true;
  }

  private saveSnapshot() {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN || !this.peerContext.isRoom) return;
    if (this.snapshotApplying) {
      this.snapshotSaveTimer = null;
      this.snapshotSaveDueAt = 0;
      this.scheduleSnapshotSave(1000);
      return;
    }
    this.snapshotSaveTimer = null;
    this.snapshotSaveDueAt = 0;
    this.snapshotDirtyAt = 0;
    let snapshot = this.createObjectSnapshot();
    Logger.debug(`save snapshot request objects=${snapshot.objects.length}`);
    this.sendSignal({ type: 'snapshot-save', snapshot });
  }

  private setPeers(peerIds: string[]) {
    peerIds = Array.from(new Set(peerIds)).sort();
    let oldPeers = this._peerIds.filter(peerId => peerId !== this.peerId);
    let added = peerIds.filter(peerId => !oldPeers.includes(peerId));
    let removed = oldPeers.filter(peerId => !peerIds.includes(peerId));

    this._peerIds = [this.peerId].concat(peerIds).sort();
    this.peerContexts.splice(0, this.peerContexts.length, ...peerIds.map(peerId => {
      let context = PeerContext.parse(peerId);
      context.isOpen = true;
      context.session.grade = PeerSessionGrade.MIDDLE;
      context.session.health = 1;
      context.session.speed = 1;
      context.session.description = 'server-relay';
      return context;
    }));

    for (let peerId of added) if (this.callback.onConnect) this.callback.onConnect(peerId);
    for (let peerId of removed) if (this.callback.onDisconnect) this.callback.onDisconnect(peerId);
    if (added.length && this.peerContext && this.peerContext.isRoom) {
      this.scheduleSnapshotSave(1000);
    }
  }

  private receiveRelayData(from: string, encoded: EncodedContainer, seq: number) {
    if (seq && seq <= this.lastSeq) return;
    const epoch = this.roomEpoch;
    const current = () => this.roomEpoch === epoch;
    this.inboundQueue = this.inboundQueue.then(() => {
      if (current() && (!seq || seq > this.lastSeq)) return this.decodeAndDispatch(from, encoded, seq, current);
    }).catch(error => this.emitError(this.peerId, 'relay-data-invalid', '受信データを処理できませんでした。', error));
  }

  private advanceCursorAfterInbound(seq: number) {
    const epoch = this.roomEpoch;
    this.inboundQueue = this.inboundQueue.then(() => {
      if (this.roomEpoch === epoch) this.lastSeq = Math.max(this.lastSeq, seq);
    }).catch(error => Logger.warn('Relay acknowledgement failed', error));
  }

  private decodeAndDispatch(from: string, encoded: EncodedContainer, seq: number, current: () => boolean = () => true): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let bytes = base64ToBytes(encoded.data);
      let byteLength = bytes.byteLength;
      this.bandwidthUsage += byteLength;
      setZeroTimeout(async () => {
        try {
          const data = encoded.isCompressed ? await decompressAsync(bytes) : bytes;
          if (current()) {
            if (this.callback.onData) this.callback.onData(from, MessagePack.decode(data));
            if (seq) this.lastSeq = Math.max(this.lastSeq, seq);
          }
          resolve();
        } catch (error) { reject(error); }
        finally { this.bandwidthUsage -= byteLength; }
      });
    });
  }

  private sendRelayData(container: RelayDataContainer, sendTo?: string) {
    this.sendSignal({
      type: 'relay-data',
      to: sendTo,
      container: {
        data: bytesToBase64(container.data),
        isCompressed: container.isCompressed
      }
    });
  }

  private sendSignal(message: any) {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  private isSameRoomPeer(peerId: string): boolean {
    if (!this.peerContext || !this.peerContext.isRoom) return false;
    let context = PeerContext.parse(peerId);
    return context.isRoom
      && context.roomId === this.peerContext.roomId
      && context.roomName === this.peerContext.roomName
      && context.digestPassword === this.peerContext.digestPassword;
  }

  private emitError(peerId: string, errorType: string, errorMessage: string, errorObject: any) {
    if (this.callback.onError) this.callback.onError(peerId, errorType, errorMessage, errorObject);
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  let chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunkSize)) as any);
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  let binary = atob(base64);
  let bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
