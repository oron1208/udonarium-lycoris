import { compressAsync, decompressAsync } from '../util/compress';
import { MessagePack } from '../util/message-pack';
import { setZeroTimeout } from '../util/zero-timeout';
import { EventSystem } from '..';
import { ObjectContext } from '../../synchronize-object/game-object';
import { ObjectStore } from '../../synchronize-object/object-store';
import { Connection, ConnectionCallback } from './connection';
import { PeerContext } from './peer-context';
import { PeerSessionGrade } from './peer-session-state';
import { Logger } from '../util/logger';

interface RelayDataContainer {
  data: Uint8Array;
  isCompressed?: boolean;
}

type EncodedContainer = { data: string, isCompressed?: boolean };
type StoredRelayEvent = { seq: number, from: string, to?: string, container: EncodedContainer };
type RoomSnapshot = { at?: number, from?: string, data?: { objects: ObjectContext[] } };
type RelayMessage =
  | { type: 'registered', id: string }
  | { type: 'ack', seq: number }
  | { type: 'peers', peers: string[] }
  | { type: 'room-snapshot', roomKey: string, seq: number, snapshotSeq?: number, snapshot?: RoomSnapshot, events: StoredRelayEvent[] }
  | { type: 'snapshot-ack', seq: number, snapshotSeq: number }
  | { type: 'snapshot-rejected', seq: number, snapshotSeq: number, reason?: string, objects?: number, previousObjects?: number }
  | { type: 'relay-data', seq?: number, from: string, to?: string, container: EncodedContainer }
  | { type: 'developer-announcement', text: string, level?: string, startsAt?: string, createdAt?: string }
  | { type: 'developer-announcement-clear', clear: boolean, createdAt?: string }
  | { type: 'snapshot-save-request', roomKey: string, seq: number }
  | { type: 'resync-request', from?: string }
  | { type: 'unavailable', id: string }
  | { type: 'error', errorType?: string, message: string };

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
  open(peerId: string)
  open(userId: string, roomId: string, roomName: string, password: string)
  open(...args: any[]) {
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
    this.openSocket();
  }

  close() {
    this.intentionalClose = true;
    this.clearReconnectTimer();
    this.stopSnapshotTimer();
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
        this.socket.removeEventListener('message', handler);
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
    if (this.socket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(this.socket.readyState)) return;
    const socket = new WebSocket(this.signalingUrl);
    this.socket = socket;
    socket.addEventListener('open', () => {
      if (this.socket !== socket) return;
      this.reconnectAttempt = 0;
      this.sendSignal({ type: 'register', id: this.peerId, mode: 'relay', sinceSeq: this.lastSeq });
    });
    socket.addEventListener('message', event => {
      if (this.socket !== socket) return;
      this.onMessage(JSON.parse(event.data));
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
    switch (message.type) {
      case 'registered':
        this.peerContext.isOpen = true;
        if (this.callback.onOpen) this.callback.onOpen(this.peerId);
        this.startSnapshotTimer();
        break;
      case 'ack':
        this.lastSeq = Math.max(this.lastSeq, message.seq || 0);
        break;
      case 'snapshot-ack':
        this.lastSeq = Math.max(this.lastSeq, message.snapshotSeq || message.seq || 0);
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
        this.setPeers(message.peers.filter(peerId => peerId !== this.peerId && this.isSameRoomPeer(peerId)));
        break;
      case 'room-snapshot':
        this.receiveSnapshot(message.events || [], message.seq || 0, message.snapshot, message.snapshotSeq || 0, message.roomKey);
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
      case 'error':
        this.emitError(this.peerId, message.errorType || 'server-error', message.message, message);
        break;
    }
  }

  private async receiveSnapshot(events: StoredRelayEvent[], serverSeq: number, snapshot?: RoomSnapshot, snapshotSeq: number = 0, roomKey?: string) {
    this.inboundQueue = this.inboundQueue.then(async () => {
      // 入室時の初回スナップショットの場合、メディアを一括ダウンロードしてから適用する
      Logger.info(`[bundle-check] snapshot=${!!snapshot} hasData=${!!(snapshot && snapshot.data)} hasObjects=${!!(snapshot && snapshot.data && snapshot.data.objects)} roomKey=${roomKey} bundleDownloaded=${this.bundleDownloaded}`);
      if (snapshot && snapshot.data && snapshot.data.objects && roomKey && !this.bundleDownloaded) {
        this.bundleDownloaded = true;
        await this.downloadMediaBundle(snapshot.data.objects, roomKey);
      }
      if (snapshot && snapshot.data && snapshot.data.objects && (snapshotSeq > this.lastSeq || this.forceSnapshotApply)) {
        await this.applyObjectSnapshot(snapshot.data.objects, snapshot.from || 'server-snapshot');
        this.forceSnapshotApply = false;
        this.lastSeq = Math.max(this.lastSeq, snapshotSeq || 0);
      }
      let replayedEvents = 0;
      for (let event of events) {
        if (event.seq <= this.lastSeq) continue;
        await this.decodeAndDispatch(event.from, event.container, event.seq);
        replayedEvents++;
      }
      this.lastSeq = Math.max(this.lastSeq, serverSeq || 0);
      if (replayedEvents > 0) this.scheduleSnapshotSave(5000);
    });
  }

  private createObjectSnapshot(): { objects: ObjectContext[] } {
    return { objects: ObjectStore.instance.getObjects().map(object => object.toContext()) };
  }

  /**
   * 入室時にルームの全メディアをZIPで一括ダウンロードする。
   * サーバーの /api/room/:roomKey/bundle から全画像・音声を1つのZIPで受け取り、
   * 展開して ImageStorage / AudioStorage に登録する。
   */
  private async downloadMediaBundle(objects: ObjectContext[], roomKey: string): Promise<void> {
    const operationId = `relay-room-media-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    let total = 0;
    try {
      const resp = await fetch(`/api/room/${encodeURIComponent(roomKey)}/bundle`, { method: 'HEAD' });
      const len = parseInt(resp.headers.get('content-length') || '0', 10);
      // HEADで存在確認（0件の場合はmanifest JSONが返る）
      if (!resp.ok) return;
    } catch (e) {
      Logger.warn('[bundle] HEAD check failed, skipping', e);
      return;
    }

    Logger.info('[bundle] downloading media bundle ZIP...');
    EventSystem.trigger('MEDIA_BUNDLE_PROGRESS', { operationId, status: 'downloading', total: 0, done: 0 });

    try {
      const { ServerMediaStorage } = await import('../../file-storage/server-media-storage');
      const { ImageStorage } = await import('../../file-storage/image-storage');
      const { AudioStorage } = await import('../../file-storage/audio-storage');
      const JSZip = (await import('jszip')).default;

      const resp = await fetch(`/api/room/${encodeURIComponent(roomKey)}/bundle`);
      if (!resp.ok) {
        Logger.warn('[bundle] fetch failed', resp.status);
        EventSystem.trigger('MEDIA_BUNDLE_PROGRESS', { operationId, status: 'done', total: 0, done: 0 });
        return;
      }

      const arrayBuffer = await resp.arrayBuffer();
      EventSystem.trigger('MEDIA_BUNDLE_PROGRESS', { operationId, status: 'extracting', total: 0, done: 0 });
      const zip = await JSZip.loadAsync(arrayBuffer);

      // manifestから件数取得
      const manifestFile = zip.file('_manifest.json');
      let manifest: Array<{ kind: string; hash: string; name: string; type: string }> = [];
      if (manifestFile) {
        manifest = JSON.parse(await manifestFile.async('text'));
      }
      total = manifest.length;
      if (total === 0) {
        EventSystem.trigger('MEDIA_BUNDLE_PROGRESS', { operationId, status: 'done', total: 0, done: 0 });
        return;
      }

      Logger.info(`[bundle] ZIP contains ${total} media files, extracting...`);

      let done = 0;
      EventSystem.trigger('MEDIA_BUNDLE_PROGRESS', { operationId, status: 'extracting', total, done });
      // ファイルを順次展開してStorageに登録
      for (const entry of manifest) {
        const zipEntry = zip.file(`${entry.kind}/${entry.hash}`);
        if (!zipEntry) {
          done++;
          EventSystem.trigger('MEDIA_BUNDLE_PROGRESS', { operationId, status: 'extracting', total, done });
          continue;
        }

        try {
          const blob = await zipEntry.async('blob');
          if (entry.kind === 'image') {
            const file = entry.name && entry.name !== entry.hash
              ? await (await import('../../file-storage/image-file')).ImageFile.createAsync(blob, entry.name)
              : await (await import('../../file-storage/image-file')).ImageFile.createAsync(blob);
            ImageStorage.instance.add(file);
          } else if (entry.kind === 'audio') {
            const file = entry.name && entry.name !== entry.hash
              ? await (await import('../../file-storage/audio-file')).AudioFile.createAsync(blob, entry.name)
              : await (await import('../../file-storage/audio-file')).AudioFile.createAsync(blob);
            AudioStorage.instance.add(file);
          }
        } catch (e) {
          Logger.warn(`[bundle] failed to extract ${entry.kind}/${entry.hash}`, e);
        }

        done++;
        EventSystem.trigger('MEDIA_BUNDLE_PROGRESS', { operationId, status: 'extracting', total, done });
      }

      // サーバーに存在をマーク（個別fetchをスキップさせる）
      for (const entry of manifest) {
        (ServerMediaStorage as any).knownOnServer?.add?.(entry.hash);
      }

      EventSystem.trigger('MEDIA_BUNDLE_PROGRESS', { operationId, status: 'done', total, done });
      Logger.info(`[bundle] extraction complete: ${done}/${total}`);
    } catch (e) {
      Logger.warn('[bundle] download failed', e);
      EventSystem.trigger('MEDIA_BUNDLE_PROGRESS', { operationId, status: 'done', total, done: 0 });
    }
  }

  private async applyObjectSnapshot(objects: ObjectContext[], sendFrom: string) {
    const syncId = `relay-snapshot-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    // Prioritize chat logs and core table objects so players see conversation
    // history and the game board first when joining a large room.
    const priorityOrder: Record<string, number> = {
      'ChatTabList': 0,
      'ChatTab': 1,
      'ChatMessage': 2,
      'GameTable': 3,
      'PeerCursor': 4,
      'GameCharacter': 5,
      'GameCharacterGroup': 6,
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
      EventSystem.trigger('INITIAL_ROOM_SYNC_PROGRESS', {
        syncId,
        phase: 'complete',
        total: sorted.length,
        done: processed
      });
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
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN || !this.peerContext.isRoom) return false;
    this.saveSnapshot();
    return true;
  }

  private saveSnapshot() {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN || !this.peerContext.isRoom) return;
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
    this.inboundQueue = this.inboundQueue.then(() => this.decodeAndDispatch(from, encoded, seq));
  }

  private decodeAndDispatch(from: string, encoded: EncodedContainer, seq: number): Promise<void> {
    return new Promise<void>((resolve) => {
      let bytes = base64ToBytes(encoded.data);
      let byteLength = bytes.byteLength;
      this.bandwidthUsage += byteLength;
      setZeroTimeout(async () => {
        let data = encoded.isCompressed ? await decompressAsync(bytes) : bytes;
        if (this.callback.onData) this.callback.onData(from, MessagePack.decode(data));
        if (seq) this.lastSeq = Math.max(this.lastSeq, seq);
        this.bandwidthUsage -= byteLength;
        resolve();
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

function defaultSignalingUrl(): string {
  let protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${location.host}/signaling`;
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
