import * as JSZip from 'jszip';

import { AudioFile } from '../file-storage/audio-file';
import { AudioStorage, CatalogItem as AudioCatalogItem } from '../file-storage/audio-storage';
import { BufferSharingTask } from '../file-storage/buffer-sharing-task';
import { ImageFile, ImageState } from '../file-storage/image-file';
import { CatalogItem as ImageCatalogItem, ImageStorage } from '../file-storage/image-storage';
import { EventSystem, Network } from '../system';
import { Logger } from '../system/util/logger';
import { UUID } from '../system/util/uuid';
import { GameObject, ObjectContext } from './game-object';
import { ObjectStore } from './object-store';
import { reconcileChatTabsFromSnapshot } from './room-snapshot-reconciler';

type PeerId = string;

interface InitialRoomSyncCapability {
  protocol: number;
  canServeZip: boolean;
  objectCount: number;
  objectVersionSum: number;
  imageCount: number;
  audioCount: number;
  connectionAgeMs: number;
}

interface InitialRoomSyncRequest {
  protocol: number;
  requestId: string;
}

interface InitialRoomSyncAccepted {
  protocol: number;
  requestId: string;
}

interface InitialRoomSyncStart extends InitialRoomSyncAccepted {
  taskIdentifier: string;
  byteLength: number;
}

interface InitialRoomSyncFailed extends InitialRoomSyncAccepted {
  reason: string;
}

interface BundleEntryManifest {
  name: string;
  kind: 'objects' | 'images' | 'audios';
  bytes: number;
  items: number;
}

interface BundleManifest {
  schema: 1;
  objectCount: number;
  imageCount: number;
  audioCount: number;
  expandedBytes: number;
  entries: BundleEntryManifest[];
}

interface ActiveRequest {
  requestId: string;
  peerId: PeerId;
  isManual: boolean;
  accepted: boolean;
  timer: any;
  receiveTask: BufferSharingTask<Uint8Array> | null;
}

export type ForceRoomResyncResult = 'started' | 'busy' | 'not-connected' | 'no-peer';

export type InitialRoomSyncProgressPhase =
  'idle' | 'preparing' | 'downloading' | 'extracting' | 'applying' | 'complete' | 'failed' | 'fallback';

export interface InitialRoomSyncProgress {
  syncId: string;
  phase: InitialRoomSyncProgressPhase;
  done: number;
  total: number;
}

export interface InitialRoomMediaCatalogEvent {
  images: ImageCatalogItem[];
  audios: AudioCatalogItem[];
  sourcePeerId: PeerId;
  /**
   * A higher-priority HTTP bundle listener can set this synchronously.  The
   * sharing systems then skip their per-file fallback for this catalog.
   */
  handled: boolean;
  /** Call after a claimed HTTP bundle fails to resume individual HTTP/P2P sync. */
  fallback: () => void;
}

const PROTOCOL_VERSION = 1;
const OFFER_WINDOW_MS = 900;
const LEGACY_FALLBACK_MS = 5000;
const REQUEST_ACCEPT_TIMEOUT_MS = 5000;
const BUNDLE_START_TIMEOUT_MS = 90 * 1000;

const MIB = 1024 * 1024;
const MAX_ZIP_BYTES = 128 * MIB;
const MAX_EXPANDED_BYTES = 256 * MIB;
const MAX_ENTRY_COUNT = 8192;
const MAX_MANIFEST_BYTES = 2 * MIB;
const MAX_OBJECT_ENTRY_BYTES = 512 * 1024;
const MAX_CATALOG_ENTRY_BYTES = 16 * MIB;
const OBJECTS_PER_ENTRY = 64;
const APPLY_YIELD_OBJECTS = 32;
const APPLY_PROGRESS_OBJECTS = 256;

/**
 * Negotiates the initial room snapshot with modern peers.  Only one peer is
 * selected and the snapshot is transferred as one ZIP-backed buffer task.
 * Legacy catalog synchronization remains available through a delayed local
 * INITIAL_ROOM_SYNC_FALLBACK event.
 */
export class InitialRoomSync {
  private static _instance: InitialRoomSync;
  static get instance(): InitialRoomSync {
    if (!InitialRoomSync._instance) InitialRoomSync._instance = new InitialRoomSync();
    return InitialRoomSync._instance;
  }

  private readonly encoder = new TextEncoder();
  private offers: Map<PeerId, InitialRoomSyncCapability> = new Map();
  private legacyFallbackTimers: Map<PeerId, any> = new Map();
  private selectionTimer: any = null;
  private activeRequest: ActiveRequest | null = null;
  private requesterSettled = false;
  private manualResyncCandidates: PeerId[] = [];
  private networkOpenedAt = performance.now();

  private servingPeers: Set<PeerId> = new Set();
  private bundleCache: { signature: string, bytes: Uint8Array, expiresAt: number } | null = null;
  private bundlePromise: Promise<Uint8Array> | null = null;

  private constructor() { }

  initialize() {
    this.destroy();
    this.resetRequesterState();
    Logger.debug('InitialRoomSync ready...');

    EventSystem.register(this)
      .on('OPEN_NETWORK', event => {
        if (!event.isSendFromSelf) return;
        this.networkOpenedAt = performance.now();
        this.resetRequesterState();
      })
      .on('CONNECT_PEER', 100, event => {
        if (!event.isSendFromSelf) return;
        this.onConnectPeer(event.data.peerId);
      })
      .on('DISCONNECT_PEER', event => {
        this.onDisconnectPeer(event.data.peerId);
      })
      .on<InitialRoomSyncCapability>('INITIAL_ROOM_SYNC_CAPABILITY', event => {
        if (event.isSendFromSelf || !this.isValidCapability(event.data)) return;
        this.offers.set(event.sendFrom, event.data);
        this.scheduleSelection();
      })
      .on<InitialRoomSyncRequest>('INITIAL_ROOM_SYNC_REQUEST', event => {
        if (event.isSendFromSelf || !this.isValidRequest(event.data)) return;
        this.acceptRequest(event.sendFrom, event.data);
      })
      .on<InitialRoomSyncAccepted>('INITIAL_ROOM_SYNC_ACCEPTED', event => {
        let request = this.activeRequest;
        if (!request || event.sendFrom !== request.peerId || event.data?.requestId !== request.requestId) return;
        request.accepted = true;
        this.resetRequestTimer(BUNDLE_START_TIMEOUT_MS, 'bundle-start-timeout');
      })
      .on<InitialRoomSyncStart>('INITIAL_ROOM_SYNC_START', event => {
        this.startReceive(event.sendFrom, event.data);
      })
      .on<InitialRoomSyncFailed>('INITIAL_ROOM_SYNC_FAILED', event => {
        let request = this.activeRequest;
        if (!request || event.sendFrom !== request.peerId || event.data?.requestId !== request.requestId) return;
        this.failActiveRequest(`remote-failed:${String(event.data.reason || 'unknown').slice(0, 80)}`);
      })
      .on<any>('INITIAL_ROOM_SYNC_LEGACY_REQUEST', event => {
        if (event.isSendFromSelf || event.data?.protocol !== PROTOCOL_VERSION) return;
        if (!Network.peerContexts.some(peer => peer.peerId === event.sendFrom && peer.isOpen)) return;
        // The requester needs this peer's catalog. Trigger the legacy send path
        // locally with the requester as its explicit destination.
        EventSystem.trigger('INITIAL_ROOM_SYNC_FALLBACK', {
          peerId: event.sendFrom,
          reason: 'remote-request'
        });
      });
  }

  destroy() {
    EventSystem.unregister(this);
    this.resetRequesterState();
    this.servingPeers.clear();
    this.bundleCache = null;
    this.bundlePromise = null;
  }

  forceResync(): ForceRoomResyncResult {
    if (!Network.isOpen) return 'not-connected';
    if (this.activeRequest || this.selectionTimer != null) return 'busy';

    let candidates = Network.peerContexts
      .filter(peer => peer.isOpen && peer.peerId && peer.peerId !== Network.peerId)
      .map(peer => peer.peerId)
      .sort((a, b) => {
        let offerA = this.offers.get(a);
        let offerB = this.offers.get(b);
        let state = offerA && offerB ? this.compareRoomState(offerB, offerA) : 0;
        return state || this.peerQuality(b) - this.peerQuality(a) || a.localeCompare(b);
      });
    if (candidates.length < 1) return 'no-peer';

    this.manualResyncCandidates = candidates;
    this.requesterSettled = false;
    let peerId = this.manualResyncCandidates.shift();
    this.requestSnapshotFrom(peerId, true);
    return 'started';
  }

  private resetRequesterState() {
    if (this.selectionTimer != null) clearTimeout(this.selectionTimer);
    this.selectionTimer = null;
    for (let timer of this.legacyFallbackTimers.values()) clearTimeout(timer);
    this.legacyFallbackTimers.clear();
    this.offers.clear();
    this.manualResyncCandidates = [];
    this.cancelActiveRequest();
    this.requesterSettled = false;
    this.reportProgress('idle');
  }

  private onConnectPeer(peerId: PeerId) {
    if (!peerId || peerId === Network.peerId) return;
    EventSystem.call('INITIAL_ROOM_SYNC_CAPABILITY', this.makeCapability(), peerId);
    this.clearLegacyFallback(peerId);
    this.legacyFallbackTimers.set(peerId, setTimeout(() => {
      this.legacyFallbackTimers.delete(peerId);
      this.useLegacyFallback(peerId, 'capability-timeout');
    }, LEGACY_FALLBACK_MS));
  }

  private onDisconnectPeer(peerId: PeerId) {
    this.offers.delete(peerId);
    this.clearLegacyFallback(peerId);
    this.servingPeers.delete(peerId);
    if (this.activeRequest?.peerId === peerId) this.failActiveRequest('peer-disconnected');
  }

  private makeCapability(): InitialRoomSyncCapability {
    let objects = ObjectStore.instance.getObjects();
    let objectVersionSum = 0;
    for (let object of objects) objectVersionSum += object.version;
    return {
      protocol: PROTOCOL_VERSION,
      canServeZip: true,
      objectCount: objects.length,
      objectVersionSum,
      imageCount: ImageStorage.instance.getCatalog().length,
      audioCount: AudioStorage.instance.getCatalog().length,
      connectionAgeMs: Math.max(0, performance.now() - this.networkOpenedAt)
    };
  }

  private isValidCapability(value: any): value is InitialRoomSyncCapability {
    if (!value || value.protocol !== PROTOCOL_VERSION || value.canServeZip !== true) return false;
    return this.isSafeCount(value.objectCount)
      && Number.isFinite(value.objectVersionSum) && 0 <= value.objectVersionSum
      && this.isSafeCount(value.imageCount)
      && this.isSafeCount(value.audioCount)
      && Number.isFinite(value.connectionAgeMs) && 0 <= value.connectionAgeMs;
  }

  private isValidRequest(value: any): value is InitialRoomSyncRequest {
    return !!value
      && value.protocol === PROTOCOL_VERSION
      && typeof value.requestId === 'string'
      && 0 < value.requestId.length
      && value.requestId.length <= 128;
  }

  private isSafeCount(value: any): boolean {
    return Number.isSafeInteger(value) && 0 <= value && value <= 10000000;
  }

  private scheduleSelection() {
    if (this.activeRequest || this.selectionTimer != null) return;
    this.selectionTimer = setTimeout(() => {
      this.selectionTimer = null;
      this.selectBestPeer();
    }, OFFER_WINDOW_MS);
  }

  private selectBestPeer() {
    if (this.activeRequest) return;
    if (this.offers.size < 1) {
      this.reportProgress('idle');
      return;
    }
    let candidates = Array.from(this.offers.entries())
      .filter(([peerId]) => Network.peerContexts.some(peer => peer.peerId === peerId && peer.isOpen));
    if (candidates.length < 1) {
      this.reportProgress('idle');
      return;
    }

    candidates.sort((a, b) => this.compareCandidates(b, a));
    let [peerId, best] = candidates[0];
    let local = this.makeCapability();
    if (this.compareRoomState(best, local) <= 0) {
      // This client is at least as complete as every offering peer.  It acts as
      // a source and does not request a duplicate snapshot.
      this.requesterSettled = true;
      this.reportProgress('idle');
      return;
    }

    // A later, fuller peer may legitimately supersede a partial/equal snapshot
    // received during a simultaneous join.
    this.requestSnapshotFrom(peerId, false);
  }

  private requestSnapshotFrom(peerId: PeerId, isManual: boolean) {
    this.requesterSettled = false;
    let requestId = UUID.generateUuid();
    this.activeRequest = {
      requestId,
      peerId,
      isManual,
      accepted: false,
      timer: null,
      receiveTask: null
    };
    // Only the selected peer may serve the initial snapshot.  Timers for other
    // capable peers would otherwise start duplicate legacy catalog transfers
    // while this ZIP is being prepared.
    for (let pendingPeerId of Array.from(this.legacyFallbackTimers.keys())) {
      this.clearLegacyFallback(pendingPeerId);
    }
    this.reportProgress('preparing', 0, 0, requestId);
    this.resetRequestTimer(REQUEST_ACCEPT_TIMEOUT_MS, 'request-not-accepted');
    EventSystem.call('INITIAL_ROOM_SYNC_REQUEST', { protocol: PROTOCOL_VERSION, requestId }, peerId);
    Logger.debug(`InitialRoomSync ${isManual ? 'manual ' : ''}request ${requestId} -> ${peerId}`);
  }

  private compareCandidates(a: [PeerId, InitialRoomSyncCapability], b: [PeerId, InitialRoomSyncCapability]): number {
    let state = this.compareRoomState(a[1], b[1]);
    if (state !== 0) return state;
    let quality = this.peerQuality(a[0]) - this.peerQuality(b[0]);
    if (quality !== 0) return quality;
    return b[0].localeCompare(a[0]);
  }

  private compareRoomState(a: InitialRoomSyncCapability, b: InitialRoomSyncCapability): number {
    if (a.objectCount !== b.objectCount) return a.objectCount - b.objectCount;
    if (a.objectVersionSum !== b.objectVersionSum) return a.objectVersionSum - b.objectVersionSum;
    if (a.imageCount !== b.imageCount) return a.imageCount - b.imageCount;
    if (a.audioCount !== b.audioCount) return a.audioCount - b.audioCount;
    // Connection age is only a final tie-breaker.  It prevents an established
    // room peer from downloading the just-joined peer's equivalent defaults.
    if (Math.abs(a.connectionAgeMs - b.connectionAgeMs) < 500) return 0;
    return a.connectionAgeMs - b.connectionAgeMs;
  }

  private peerQuality(peerId: PeerId): number {
    let peer = Network.peerContexts.find(context => context.peerId === peerId);
    if (!peer) return 0;
    return (peer.session.grade || 0) * 100 + (peer.session.health || 0) * 10 + (peer.session.speed || 0);
  }

  private acceptRequest(peerId: PeerId, request: InitialRoomSyncRequest) {
    if (this.servingPeers.has(peerId)) return;
    if (this.activeRequest && !this.requesterSettled) {
      EventSystem.call('INITIAL_ROOM_SYNC_FAILED', {
        protocol: PROTOCOL_VERSION,
        requestId: request.requestId,
        reason: 'source-not-ready'
      }, peerId);
      return;
    }
    this.clearLegacyFallback(peerId);
    this.servingPeers.add(peerId);
    EventSystem.call('INITIAL_ROOM_SYNC_ACCEPTED', {
      protocol: PROTOCOL_VERSION,
      requestId: request.requestId
    }, peerId);

    // ZIP generation is shared, while every accepted peer starts promptly.
    // Serializing whole transfers made queued clients exceed the start timeout.
    this.serveBundle(peerId, request)
      .catch(error => {
        Logger.warn('InitialRoomSync serve failed', error);
        EventSystem.call('INITIAL_ROOM_SYNC_FAILED', {
          protocol: PROTOCOL_VERSION,
          requestId: request.requestId,
          reason: error instanceof Error ? error.message.slice(0, 80) : 'bundle-build-failed'
        }, peerId);
      })
      .then(() => { this.servingPeers.delete(peerId); });
  }

  private async serveBundle(peerId: PeerId, request: InitialRoomSyncRequest): Promise<void> {
    if (!Network.peerContexts.some(peer => peer.peerId === peerId && peer.isOpen)) return;
    let bytes = await this.getOrCreateBundle();
    let taskIdentifier = `initial-room-${request.requestId}`;
    let task = BufferSharingTask.createSendTask<Uint8Array>(taskIdentifier, peerId);

    EventSystem.call('INITIAL_ROOM_SYNC_START', {
      protocol: PROTOCOL_VERSION,
      requestId: request.requestId,
      taskIdentifier,
      byteLength: bytes.byteLength
    }, peerId);

    await new Promise<void>(resolve => {
      task.onfinish = () => resolve();
      task.ontimeout = () => Logger.warn(`InitialRoomSync send timeout -> ${peerId}`);
      task.oncancel = () => Logger.warn(`InitialRoomSync send canceled -> ${peerId}`);
      task.start(bytes);
    });
  }

  private async getOrCreateBundle(): Promise<Uint8Array> {
    let signature = this.bundleSignature();
    let now = performance.now();
    if (this.bundleCache && this.bundleCache.signature === signature && now < this.bundleCache.expiresAt) {
      return this.bundleCache.bytes;
    }
    if (this.bundlePromise) return this.bundlePromise;
    this.bundlePromise = this.createBundle()
      .then(bytes => {
        this.bundleCache = { signature, bytes, expiresAt: performance.now() + 15000 };
        return bytes;
      })
      .finally(() => { this.bundlePromise = null; });
    return this.bundlePromise;
  }

  private bundleSignature(): string {
    let capability = this.makeCapability();
    return [
      capability.objectCount,
      capability.objectVersionSum,
      capability.imageCount,
      capability.audioCount
    ].join(':');
  }

  private async createBundle(): Promise<Uint8Array> {
    let zip = new JSZip();
    let entries: BundleEntryManifest[] = [];
    let expandedBytes = 0;
    let objectCount = 0;
    let batchIndex = 0;
    let objectJsonParts: string[] = [];
    let objectBatchBytes = 2;
    let referencedImages = new Set<string>();

    let flushObjectBatch = () => {
      if (objectJsonParts.length < 1) return;
      let json = `[${objectJsonParts.join(',')}]`;
      let bytes = this.byteLength(json);
      if (bytes > MAX_OBJECT_ENTRY_BYTES) throw new Error('object ZIP entry is too large');
      let name = `objects/${String(batchIndex++).padStart(6, '0')}.json`;
      zip.file(name, json);
      entries.push({ name, kind: 'objects', bytes, items: objectJsonParts.length });
      expandedBytes += bytes;
      objectJsonParts = [];
      objectBatchBytes = 2;
    };

    let objects = ObjectStore.instance.getObjects().slice().sort(this.compareObjectPriority);
    for (let object of objects) {
      let context = object.toContext();
      this.collectReferencedImages(context, referencedImages);
      let json = JSON.stringify(context);
      let bytes = this.byteLength(json);
      if (bytes + 2 > MAX_OBJECT_ENTRY_BYTES) throw new Error(`object context is too large: ${object.identifier}`);
      let separatorBytes = objectJsonParts.length ? 1 : 0;
      if (objectJsonParts.length >= OBJECTS_PER_ENTRY
        || (objectJsonParts.length > 0 && MAX_OBJECT_ENTRY_BYTES < objectBatchBytes + separatorBytes + bytes)) {
        flushObjectBatch();
      }
      objectJsonParts.push(json);
      objectBatchBytes += (objectJsonParts.length > 1 ? 1 : 0) + bytes;
      objectCount++;
    }
    flushObjectBatch();

    let images = this.mergeReferencedImages(ImageStorage.instance.getCatalog(), referencedImages);
    let imageJson = JSON.stringify(images);
    let imageBytes = this.byteLength(imageJson);
    if (imageBytes > MAX_CATALOG_ENTRY_BYTES) throw new Error('image catalog is too large');
    zip.file('catalogs/images.json', imageJson);
    entries.push({ name: 'catalogs/images.json', kind: 'images', bytes: imageBytes, items: images.length });
    expandedBytes += imageBytes;

    let audios = AudioStorage.instance.getCatalog();
    let audioJson = JSON.stringify(audios);
    let audioBytes = this.byteLength(audioJson);
    if (audioBytes > MAX_CATALOG_ENTRY_BYTES) throw new Error('audio catalog is too large');
    zip.file('catalogs/audios.json', audioJson);
    entries.push({ name: 'catalogs/audios.json', kind: 'audios', bytes: audioBytes, items: audios.length });
    expandedBytes += audioBytes;

    if (expandedBytes > MAX_EXPANDED_BYTES || entries.length + 1 > MAX_ENTRY_COUNT) {
      throw new Error('initial room ZIP exceeds safety limits');
    }

    let manifest: BundleManifest = {
      schema: 1,
      objectCount,
      imageCount: images.length,
      audioCount: audios.length,
      expandedBytes,
      entries
    };
    let manifestJson = JSON.stringify(manifest);
    if (this.byteLength(manifestJson) > MAX_MANIFEST_BYTES) throw new Error('initial room ZIP manifest is too large');
    zip.file('_manifest.json', manifestJson);

    let bytes = await zip.generateAsync({
      type: 'uint8array',
      compression: 'DEFLATE',
      compressionOptions: { level: 1 },
      streamFiles: true
    });
    if (bytes.byteLength > MAX_ZIP_BYTES) throw new Error('initial room ZIP is too large');
    Logger.debug(`InitialRoomSync ZIP objects=${objectCount} compressed=${bytes.byteLength} expanded=${expandedBytes}`);
    return bytes;
  }

  private compareObjectPriority(a: GameObject, b: GameObject): number {
    const priority: { [aliasName: string]: number } = {
      'chat-tab-list': 0,
      'chat-tab': 1,
      'chat': 2,
      'game-table': 3,
      PeerCursor: 4,
      'character': 5,
      'character-group': 6
    };
    let diff = (priority[a.aliasName] ?? 99) - (priority[b.aliasName] ?? 99);
    return diff || a.identifier.localeCompare(b.identifier);
  }

  /**
   * A room object can already reference an image whose local ImageStorage
   * entry is still an empty/lazy placeholder. Include those hashes in the
   * initial catalog so the following HTTP media ZIP can fetch card and dice
   * faces directly from the server instead of silently omitting them.
   */
  private collectReferencedImages(context: ObjectContext, identifiers: Set<string>): void {
    const hashPattern = /^[a-f0-9]{64}$/i;
    const syncData: any = context && context.syncData;
    if (!syncData || typeof syncData !== 'object') return;

    const isImageDataElement = context.aliasName === 'data'
      && (syncData.type === 'image' || syncData.attributes?.type === 'image');
    if (isImageDataElement && typeof syncData.value === 'string' && hashPattern.test(syncData.value)) {
      identifiers.add(syncData.value.toLowerCase());
    }

    const seen = new Set<any>();
    const walk = (value: any, key: string = '') => {
      if (typeof value === 'string') {
        if (/imageIdentifier$/i.test(key) && hashPattern.test(value)) identifiers.add(value.toLowerCase());
        return;
      }
      if (!value || typeof value !== 'object' || seen.has(value)) return;
      seen.add(value);
      if (Array.isArray(value)) {
        for (const child of value) walk(child);
      } else {
        for (const childKey of Object.keys(value)) walk(value[childKey], childKey);
      }
    };
    walk(syncData);
  }

  private mergeReferencedImages(catalog: ImageCatalogItem[], identifiers: Set<string>): ImageCatalogItem[] {
    const merged = catalog.slice();
    const existing = new Set(catalog.map(item => item.identifier.toLowerCase()));
    for (const identifier of identifiers) {
      if (existing.has(identifier)) continue;
      existing.add(identifier);
      merged.push({ identifier, state: ImageState.COMPLETE });
    }
    return merged;
  }

  private startReceive(peerId: PeerId, start: InitialRoomSyncStart) {
    let request = this.activeRequest;
    if (!request || this.requesterSettled || request.receiveTask) return;
    if (peerId !== request.peerId || start?.requestId !== request.requestId || start.protocol !== PROTOCOL_VERSION) return;
    if (start.taskIdentifier !== `initial-room-${request.requestId}` || start.taskIdentifier.length > 256) return;
    if (!Number.isSafeInteger(start.byteLength) || start.byteLength < 1 || start.byteLength > MAX_ZIP_BYTES) {
      this.failActiveRequest('invalid-bundle-size');
      return;
    }

    if (request.timer != null) clearTimeout(request.timer);
    request.timer = null;
    // BufferSharingTask adds a small MessagePack wrapper around the ZIP.
    // Bound it before any chunk array/allocation occurs on low-memory clients.
    let task = BufferSharingTask.createReceiveTask<Uint8Array>(
      start.taskIdentifier,
      peerId,
      start.byteLength + 1024,
    );
    request.receiveTask = task;
    let lastReportedPercent = -1;
    this.reportProgress('downloading', 0, 0, request.requestId);
    task.onprogress = (_task, loadedIndex, total) => {
      let done = Math.min(total, loadedIndex + 1);
      let percent = 0 < total ? Math.floor(done / total * 100) : -1;
      if (percent === lastReportedPercent && done < total) return;
      lastReportedPercent = percent;
      this.reportProgress('downloading', done, total, request.requestId);
    };
    task.ontimeout = () => {
      if (this.activeRequest === request) this.failActiveRequest('bundle-transfer-timeout');
    };
    task.oncancel = () => {
      if (this.activeRequest === request) this.failActiveRequest('bundle-transfer-canceled');
    };
    task.onfinish = (_task, data) => {
      request.receiveTask = null;
      if (this.activeRequest !== request) return;
      if (!data) {
        this.failActiveRequest('bundle-transfer-invalid');
        return;
      }
      this.applyBundle(data, request, start.byteLength).catch(error => {
        if (this.activeRequest !== request) {
          Logger.debug(`InitialRoomSync discarded superseded apply ${request.requestId}`);
          return;
        }
        Logger.warn('InitialRoomSync apply failed', error);
        this.failActiveRequest('bundle-apply-failed');
      });
    };
    task.start();
  }

  private async applyBundle(data: Uint8Array, request: ActiveRequest, announcedBytes: number): Promise<void> {
    this.assertActiveRequest(request);
    const sourcePeerId = request.peerId;
    this.reportProgress('extracting', 0, 0, request.requestId);
    let bytes = this.asUint8Array(data);
    if (!bytes || bytes.byteLength !== announcedBytes || bytes.byteLength > MAX_ZIP_BYTES) {
      throw new Error('initial room ZIP size mismatch');
    }

    let zip = await JSZip.loadAsync(bytes);
    this.assertActiveRequest(request);
    let files = Object.keys(zip.files)
      .map(name => zip.files[name])
      .filter(entry => !entry.dir);
    if (files.length < 3 || files.length > MAX_ENTRY_COUNT) throw new Error('invalid initial room ZIP entry count');
    for (let file of files) {
      if (!this.isSafeZipPath(file.name)) throw new Error(`unsafe initial room ZIP path: ${file.name}`);
    }

    let declaredExpandedBytes = 0;
    for (let file of files) {
      let size = this.declaredUncompressedSize(file);
      if (size == null || size < 0) throw new Error(`missing ZIP size metadata: ${file.name}`);
      declaredExpandedBytes += size;
      if (declaredExpandedBytes > MAX_EXPANDED_BYTES + MAX_MANIFEST_BYTES) {
        throw new Error('initial room ZIP expands beyond safety limit');
      }
    }

    let manifestFile = zip.file('_manifest.json');
    if (!manifestFile || this.declaredUncompressedSize(manifestFile) > MAX_MANIFEST_BYTES) {
      throw new Error('invalid initial room ZIP manifest');
    }
    let manifestText = await manifestFile.async('string');
    this.assertActiveRequest(request);
    if (this.byteLength(manifestText) > MAX_MANIFEST_BYTES) throw new Error('initial room ZIP manifest is too large');
    let manifest = JSON.parse(manifestText) as BundleManifest;
    this.validateManifest(manifest, files);

    let imageCatalog = await this.readCatalog<ImageCatalogItem>(zip, manifest, 'images');
    this.assertActiveRequest(request);
    let audioCatalog = await this.readCatalog<AudioCatalogItem>(zip, manifest, 'audios');
    this.assertActiveRequest(request);
    this.installMediaPlaceholders(imageCatalog, audioCatalog);
    let applied = 0;
    const chatSnapshotContexts: ObjectContext[] = [];
    let objectEntries = manifest.entries.filter(entry => entry.kind === 'objects').sort((a, b) => a.name.localeCompare(b.name));
    this.reportProgress('applying', 0, manifest.objectCount, request.requestId);

    for (let entry of objectEntries) {
      let file = zip.file(entry.name);
      let text = await file.async('string');
      this.assertActiveRequest(request);
      if (this.byteLength(text) !== entry.bytes || entry.bytes > MAX_OBJECT_ENTRY_BYTES) {
        throw new Error(`object ZIP entry size mismatch: ${entry.name}`);
      }
      let contexts = JSON.parse(text) as ObjectContext[];
      if (!Array.isArray(contexts) || contexts.length !== entry.items || contexts.length > OBJECTS_PER_ENTRY) {
        throw new Error(`invalid object ZIP entry: ${entry.name}`);
      }
      for (let context of contexts) {
        this.assertActiveRequest(request);
        if (!this.isValidObjectContext(context)) throw new Error(`invalid object context in ${entry.name}`);
        if (context.aliasName === 'chat-tab-list' || context.aliasName === 'chat-tab') {
          chatSnapshotContexts.push(context);
        }
        EventSystem.trigger({ eventName: 'UPDATE_GAME_OBJECT', data: context, sendFrom: sourcePeerId });
        applied++;
        if (applied % APPLY_PROGRESS_OBJECTS === 0) {
          this.reportProgress('applying', applied, manifest.objectCount, request.requestId);
        }
        if (applied % APPLY_YIELD_OBJECTS === 0) {
          await this.yieldToUi();
          this.assertActiveRequest(request);
        }
      }
      contexts.length = 0;
    }
    if (applied !== manifest.objectCount) throw new Error('initial room object count mismatch');
    reconcileChatTabsFromSnapshot(chatSnapshotContexts);
    this.reportProgress('applying', applied, manifest.objectCount, request.requestId);

    this.assertActiveRequest(request);
    this.requesterSettled = true;
    this.manualResyncCandidates = [];
    this.cancelActiveRequest(false);
    let didFallback = false;
    let fallback = () => {
      if (didFallback) return;
      didFallback = true;
      EventSystem.trigger('INITIAL_ROOM_MEDIA_CATALOG_FALLBACK', {
        images: imageCatalog,
        audios: audioCatalog,
        sourcePeerId
      });
    };
    let mediaEvent: InitialRoomMediaCatalogEvent = {
      images: imageCatalog,
      audios: audioCatalog,
      sourcePeerId,
      handled: false,
      fallback
    };
    EventSystem.trigger('INITIAL_ROOM_MEDIA_CATALOG', mediaEvent);
    if (!mediaEvent.handled) fallback();
    EventSystem.trigger('INITIAL_ROOM_SYNC_COMPLETE', {
      sourcePeerId,
      objectCount: applied,
      imageCount: imageCatalog.length,
      audioCount: audioCatalog.length
    });
    this.reportProgress('complete', applied, manifest.objectCount, request.requestId);
    Logger.debug(`InitialRoomSync complete <- ${sourcePeerId}, objects=${applied}`);
  }

  private installMediaPlaceholders(images: ImageCatalogItem[], audios: AudioCatalogItem[]) {
    // Installing empty records first prevents object onStoreAdded hooks from
    // issuing thousands of eager individual HTTP requests while the snapshot
    // itself is still being applied.
    // Only create placeholders for SHA-256 hash identifiers. URL-based
    // identifiers (e.g. ./assets/images/trump/x02.gif) are local assets
    // that must NOT be pre-registered as empty, otherwise
    // ImageStorage.get(url) returns the empty entry and blocks the
    // normal add(url) path that sets the URL.
    const hashPattern = /^[a-f0-9]{64}$/i;
    for (let item of images) {
      if (!hashPattern.test(item.identifier)) continue;
      if (!ImageStorage.instance.get(item.identifier, false)) {
        ImageStorage.instance.add(ImageFile.createEmpty(item.identifier));
      }
    }
    for (let item of audios) {
      if (!hashPattern.test(item.identifier)) continue;
      let audio = AudioStorage.instance.get(item.identifier, false);
      if (!audio) {
        audio = AudioFile.createEmpty(item.identifier);
        AudioStorage.instance.add(audio);
      }
      if (item.name && (!audio.name || audio.name === audio.identifier)) {
        audio.apply({
          identifier: item.identifier,
          name: item.name,
          type: '',
          blob: null,
          url: ''
        });
      }
    }
  }

  private validateManifest(manifest: BundleManifest, files: any[]) {
    if (!manifest || manifest.schema !== 1 || !Array.isArray(manifest.entries)) throw new Error('unsupported initial room ZIP manifest');
    if (!this.isSafeCount(manifest.objectCount)
      || !this.isSafeCount(manifest.imageCount)
      || !this.isSafeCount(manifest.audioCount)
      || !Number.isSafeInteger(manifest.expandedBytes)
      || manifest.expandedBytes < 0
      || manifest.expandedBytes > MAX_EXPANDED_BYTES) {
      throw new Error('invalid initial room ZIP manifest counts');
    }
    if (manifest.entries.length + 1 !== files.length || manifest.entries.length + 1 > MAX_ENTRY_COUNT) {
      throw new Error('initial room ZIP manifest entry count mismatch');
    }

    let names = new Set<string>();
    let expandedBytes = 0;
    let objectCount = 0;
    let imageEntries = 0;
    let audioEntries = 0;
    for (let entry of manifest.entries) {
      if (!entry || typeof entry.name !== 'string' || names.has(entry.name) || !this.isSafeZipPath(entry.name)) {
        throw new Error('invalid initial room ZIP manifest entry');
      }
      names.add(entry.name);
      if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || !this.isSafeCount(entry.items)) {
        throw new Error(`invalid initial room ZIP entry metadata: ${entry.name}`);
      }
      let file = files.find(candidate => candidate.name === entry.name);
      if (!file || this.declaredUncompressedSize(file) !== entry.bytes) {
        throw new Error(`initial room ZIP entry size mismatch: ${entry.name}`);
      }
      if (entry.kind === 'objects') {
        if (!/^objects\/\d{6}\.json$/.test(entry.name) || entry.bytes > MAX_OBJECT_ENTRY_BYTES || entry.items > OBJECTS_PER_ENTRY) {
          throw new Error(`invalid object ZIP entry metadata: ${entry.name}`);
        }
        objectCount += entry.items;
      } else if (entry.kind === 'images') {
        if (entry.name !== 'catalogs/images.json' || ++imageEntries > 1 || entry.bytes > MAX_CATALOG_ENTRY_BYTES) {
          throw new Error('invalid image catalog ZIP entry');
        }
      } else if (entry.kind === 'audios') {
        if (entry.name !== 'catalogs/audios.json' || ++audioEntries > 1 || entry.bytes > MAX_CATALOG_ENTRY_BYTES) {
          throw new Error('invalid audio catalog ZIP entry');
        }
      } else {
        throw new Error(`unsupported initial room ZIP entry: ${entry.name}`);
      }
      expandedBytes += entry.bytes;
      if (expandedBytes > MAX_EXPANDED_BYTES) throw new Error('initial room ZIP expands beyond safety limit');
    }
    if (objectCount !== manifest.objectCount || imageEntries !== 1 || audioEntries !== 1 || expandedBytes !== manifest.expandedBytes) {
      throw new Error('initial room ZIP manifest totals mismatch');
    }
    if (!files.every(file => file.name === '_manifest.json' || names.has(file.name))) {
      throw new Error('initial room ZIP contains an unlisted entry');
    }
  }

  private async readCatalog<T>(zip: JSZip, manifest: BundleManifest, kind: 'images' | 'audios'): Promise<T[]> {
    let metadata = manifest.entries.find(entry => entry.kind === kind);
    let file = metadata ? zip.file(metadata.name) : null;
    if (!metadata || !file) throw new Error(`missing ${kind} catalog`);
    let text = await file.async('string');
    if (this.byteLength(text) !== metadata.bytes) throw new Error(`${kind} catalog size mismatch`);
    let catalog = JSON.parse(text);
    if (!Array.isArray(catalog) || catalog.length !== metadata.items) throw new Error(`invalid ${kind} catalog`);
    if (kind === 'images' && catalog.length !== manifest.imageCount) throw new Error('image catalog count mismatch');
    if (kind === 'audios' && catalog.length !== manifest.audioCount) throw new Error('audio catalog count mismatch');
    for (let item of catalog) {
      if (!item || typeof item.identifier !== 'string' || item.identifier.length > 2048
        || !Number.isFinite(item.state) || item.state < 0) {
        throw new Error(`invalid ${kind} catalog item`);
      }
      if (kind === 'audios' && item.name != null && typeof item.name !== 'string') {
        throw new Error('invalid audio catalog item name');
      }
    }
    return catalog as T[];
  }

  private isValidObjectContext(context: any): context is ObjectContext {
    return !!context
      && typeof context.aliasName === 'string' && 0 < context.aliasName.length && context.aliasName.length <= 256
      && typeof context.identifier === 'string' && 0 < context.identifier.length && context.identifier.length <= 2048
      && Number.isFinite(context.majorVersion)
      && Number.isFinite(context.minorVersion)
      && context.syncData != null
      && typeof context.syncData === 'object';
  }

  private isSafeZipPath(path: string): boolean {
    return !!path
      && path.length <= 256
      && !path.startsWith('/')
      && !path.startsWith('\\')
      && !path.includes('..')
      && !path.includes('\\');
  }

  private declaredUncompressedSize(entry: any): number | null {
    let size = entry?._data?.uncompressedSize;
    return Number.isSafeInteger(size) ? size : null;
  }

  private byteLength(text: string): number {
    return this.encoder.encode(text).byteLength;
  }

  private asUint8Array(data: any): Uint8Array | null {
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (data && data.buffer instanceof ArrayBuffer && Number.isSafeInteger(data.byteLength)) {
      return new Uint8Array(data.buffer, data.byteOffset || 0, data.byteLength);
    }
    return null;
  }

  private yieldToUi(): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, 0));
  }

  private assertActiveRequest(request: ActiveRequest) {
    if (this.activeRequest !== request) throw new Error('initial room sync request was superseded');
  }

  private reportProgress(
    phase: InitialRoomSyncProgressPhase,
    done: number = 0,
    total: number = 0,
    syncId: string = ''
  ) {
    let progress: InitialRoomSyncProgress = {
      syncId: String(syncId || '').slice(0, 128),
      phase,
      done: Number.isSafeInteger(done) && 0 <= done ? done : 0,
      total: Number.isSafeInteger(total) && 0 <= total ? total : 0
    };
    EventSystem.trigger('INITIAL_ROOM_SYNC_PROGRESS', progress);
  }

  private resetRequestTimer(ms: number, reason: string) {
    let request = this.activeRequest;
    if (!request) return;
    if (request.timer != null) clearTimeout(request.timer);
    request.timer = setTimeout(() => {
      if (this.activeRequest === request) this.failActiveRequest(reason);
    }, ms);
  }

  private failActiveRequest(reason: string) {
    let request = this.activeRequest;
    let peerId = request?.peerId;
    let requestId = request?.requestId || '';
    Logger.warn(`InitialRoomSync fallback: ${reason}`, peerId);
    this.cancelActiveRequest();
    if (peerId) this.offers.delete(peerId);

    if (request?.isManual) {
      let nextPeerId: PeerId = null;
      while (!nextPeerId && 0 < this.manualResyncCandidates.length) {
        let candidateId = this.manualResyncCandidates.shift();
        if (Network.peerContexts.some(peer => peer.peerId === candidateId && peer.isOpen)) nextPeerId = candidateId;
      }
      if (nextPeerId) {
        this.requesterSettled = false;
        this.requestSnapshotFrom(nextPeerId, true);
        return;
      }
      this.manualResyncCandidates = [];
    }

    let local = this.makeCapability();
    let hasBetterPeer = !request?.isManual && Array.from(this.offers.entries()).some(([candidateId, capability]) =>
      Network.peerContexts.some(peer => peer.peerId === candidateId && peer.isOpen)
      && this.compareRoomState(capability, local) > 0
    );
    if (hasBetterPeer) {
      this.requesterSettled = false;
      this.reportProgress('preparing', 0, 0, requestId);
      this.scheduleSelection();
      return;
    }

    this.requesterSettled = true;
    let fallbackPeer = peerId && Network.peerContexts.some(peer => peer.peerId === peerId && peer.isOpen)
      ? peerId
      : Network.peerContexts.find(peer => peer.isOpen)?.peerId;
    if (fallbackPeer) {
      this.useLegacyFallback(fallbackPeer, reason);
      return;
    }
    this.reportProgress('failed', 0, 0, requestId);
  }

  private cancelActiveRequest(cancelTransfer: boolean = true) {
    let request = this.activeRequest;
    if (!request) return;
    // Clear ownership before cancel() invokes task callbacks, otherwise an
    // oncancel -> failActiveRequest re-entry can emit the legacy fallback twice.
    this.activeRequest = null;
    if (request.timer != null) clearTimeout(request.timer);
    if (cancelTransfer && request.receiveTask) request.receiveTask.cancel();
    request.timer = null;
    request.receiveTask = null;
  }

  private useLegacyFallback(peerId: PeerId, reason: string) {
    this.clearLegacyFallback(peerId);
    if (!peerId || !Network.peerContexts.some(peer => peer.peerId === peerId && peer.isOpen)) return;
    for (let pendingPeerId of Array.from(this.legacyFallbackTimers.keys())) {
      this.clearLegacyFallback(pendingPeerId);
    }
    this.requesterSettled = true;
    this.manualResyncCandidates = [];
    this.reportProgress('fallback');
    // Exchange catalogs in both directions. Modern peers answer the explicit
    // request; old clients ignore it but still understand our normal catalogs.
    EventSystem.call('INITIAL_ROOM_SYNC_LEGACY_REQUEST', {
      protocol: PROTOCOL_VERSION,
      reason: String(reason || '').slice(0, 80)
    }, peerId);
    EventSystem.trigger('INITIAL_ROOM_SYNC_FALLBACK', { peerId, reason });
  }

  private clearLegacyFallback(peerId: PeerId) {
    let timer = this.legacyFallbackTimers.get(peerId);
    if (timer != null) clearTimeout(timer);
    this.legacyFallbackTimers.delete(peerId);
  }
}
