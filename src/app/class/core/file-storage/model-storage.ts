import { Database } from '../../database/database';
import { EventSystem, Network } from '../system';
import { Logger } from '../system/util/logger';
import { UUID } from '../system/util/uuid';
import { BlobIntegrity } from './blob-integrity';
import { BufferSharingTask } from './buffer-sharing-task';
import { FileReaderUtil } from './file-reader-util';

export type ModelKind = 'glb' | 'gltf' | 'fbx';
export interface ModelResource {
  identifier: string;
  name: string;
  kind: ModelKind;
  size: number;
  blob?: Blob;
}

/** Content-addressed model bytes, independent of the image/audio decoders. */
export class ModelStorage {
  static readonly MAX_BYTES = 150 * 1024 * 1024;
  private static singleton: ModelStorage;
  static get instance(): ModelStorage { return this.singleton || (this.singleton = new ModelStorage()); }

  private db = new Database<ModelResource>('MediaCacheModel');
  private resources = new Map<string, ModelResource>();
  private fetching = new Map<string, Promise<ModelResource>>();
  private providers = new Map<string, Set<string>>();
  // Cache possession is not permission to advertise another room's library.
  private shared = new Set<string>();
  private announceTimer: ReturnType<typeof setTimeout>;
  private roomEpoch = 0;
  private requests = new Map<string, { identifier: string; peer: string; task?: BufferSharingTask<Uint8Array>; started: () => void; resolve: (file: ModelResource) => void }>();
  private transfers = new Set<BufferSharingTask<any>>();
  private uploading = new Map<string, Promise<void>>();
  readonly ready: Promise<void>;

  private constructor() {
    this.ready = this.restore();
    EventSystem.register(this)
      .on('CONNECT_PEER', event => {
        if (event.isSendFromSelf) void this.ready.then(() => this.announce(event.data.peerId));
      })
      .on('OPEN_NETWORK', () => {
        this.roomEpoch++;
        this.shared.clear();
        this.providers.clear();
        for (const request of this.requests.values()) request.resolve(null);
        for (const task of Array.from(this.transfers)) task.cancel();
      })
      .on('MODEL3D_CATALOG', event => {
        if (event.isSendFromSelf || !Array.isArray(event.data)) return;
        for (const data of event.data.slice(0, 1024)) {
          if (!this.valid(data)) continue;
          const peers = this.providers.get(data.identifier) || new Set<string>();
          peers.add(event.sendFrom);
          this.providers.set(data.identifier, peers);
          this.shared.add(data.identifier);
          if (!this.resources.has(data.identifier)) this.resources.set(data.identifier, this.metadata(data));
        }
        this.changed();
      })
      .on('REQUEST_MODEL3D', event => {
        if (event.isSendFromSelf || !/^[a-zA-Z0-9-]{1,128}$/.test(event.data?.requestId || '')) return;
        void this.send(event.data.identifier, event.data.requestId, event.sendFrom);
      })
      .on('MODEL3D_UNAVAILABLE', event => {
        const request = this.requests.get(event.data?.requestId);
        if (request?.peer === event.sendFrom && request.identifier === event.data?.identifier) request.resolve(null);
      })
      .on('DISCONNECT_PEER', event => {
        for (const request of this.requests.values()) if (request.peer === event.data?.peerId) request.resolve(null);
      })
      .on('START_MODEL3D', event => {
        if (event.isSendFromSelf) return;
        const data = event.data;
        const request = this.requests.get(data?.requestId);
        if (!request || request.peer !== event.sendFrom || request.task || request.identifier !== data?.identifier || !this.valid(data)
          || data.taskIdentifier !== 'model3d-' + data.requestId || this.transfers.size >= 6) return;
        // Each request is addressed to one provider; chunks from others are rejected by BufferSharingTask.
        const task = BufferSharingTask.createReceiveTask<Uint8Array>(data.taskIdentifier, event.sendFrom, ModelStorage.MAX_BYTES + 1024);
        request.task = task;
        // Once accepted, use BufferSharingTask's idle timeout, not a fixed total download duration.
        request.started();
        this.transfers.add(task);
        task.onfinish = (_task, bytes) => {
          this.transfers.delete(task);
          if (!(bytes instanceof Uint8Array) || bytes.byteLength !== data.size) { request.resolve(null); return; }
          void this.accept({ ...this.metadata(data), blob: new Blob([new Uint8Array(bytes).buffer]) }).then(file => request.resolve(file)).catch(() => request.resolve(null));
        };
        task.start();
      });
  }

  static kind(name: string): ModelKind {
    if (/\.fbx$/i.test(name)) return 'fbx';
    if (/\.gltf$/i.test(name)) return 'gltf';
    if (/\.(glb|vrm)$/i.test(name)) return 'glb';
    throw new Error('対応形式は .glb .gltf .vrm .fbx です');
  }

  private valid(file: ModelResource): boolean {
    if (!file || !/^[a-f0-9]{64}$/.test(file.identifier || '') || typeof file.name !== 'string'
      || file.name.length > 512 || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > ModelStorage.MAX_BYTES) return false;
    try { return ModelStorage.kind(file.name) === file.kind; } catch { return false; }
  }

  private metadata(file: ModelResource): ModelResource {
    return { identifier: file.identifier, name: file.name, kind: file.kind, size: file.size };
  }

  private async restore(): Promise<void> {
    const records = await this.db.getAll() || [];
    for (const file of records) {
      if (this.valid(file) && file.blob?.size === file.size) this.resources.set(file.identifier, file);
    }
    this.changed();
  }

  list(): ModelResource[] { return Array.from(this.resources.values()); }
  get(identifier: string): ModelResource { return this.resources.get(identifier); }
  private changed() { EventSystem.trigger('MODEL3D_CHANGED', {}); }
  private announce(peer?: string) {
    const catalog = this.list().filter(file => file.blob && this.shared.has(file.identifier)).slice(0, 1024).map(file => this.metadata(file));
    if (catalog.length) EventSystem.call('MODEL3D_CATALOG', catalog, peer);
  }

  /** Publish only an explicitly imported or currently referenced resource in the active room. */
  share(identifier: string) {
    if (!/^[a-f0-9]{64}$/.test(identifier || '') || this.shared.has(identifier)) return;
    this.shared.add(identifier);
    if (!this.announceTimer) this.announceTimer = setTimeout(() => {
      this.announceTimer = null;
      this.announce();
    }, 100);
  }

  async add(name: string, blob: Blob): Promise<ModelResource> {
    const kind = ModelStorage.kind(name);
    if (blob.size < 1 || blob.size > ModelStorage.MAX_BYTES) throw new Error('3Dモデルは150MB以下のファイルを選んでください');
    await this.ready;
    const identifier = await FileReaderUtil.calcSHA256Async(blob);
    const file = await this.accept({ identifier, name, kind, size: blob.size, blob });
    this.share(identifier);
    return file;
  }

  private async accept(file: ModelResource): Promise<ModelResource> {
    if (!this.valid(file) || !file.blob || file.blob.size !== file.size || !(await BlobIntegrity.isIntact(file.identifier, file.blob))) {
      throw new Error('3Dモデルの内容ハッシュが一致しません');
    }
    const existing = this.resources.get(file.identifier);
    if (existing?.blob) return existing;
    this.resources.set(file.identifier, file);
    if (await this.db.put(file.identifier, file) === null) Logger.warn('[ModelStorage] persistent cache unavailable', file.identifier);
    this.changed();
    if (this.shared.has(file.identifier)) this.announce();
    void this.upload(file);
    return file;
  }

  ensure(identifier: string, name: string = ''): Promise<ModelResource> {
    if (!/^[a-f0-9]{64}$/.test(identifier || '')) return Promise.resolve(null);
    const pending = this.fetching.get(identifier);
    if (pending) return pending;
    const promise = this.fetch(identifier, name).finally(() => this.fetching.delete(identifier));
    this.fetching.set(identifier, promise);
    return promise;
  }

  private async fetch(identifier: string, name: string): Promise<ModelResource> {
    await this.ready;
    const local = this.resources.get(identifier);
    if (local?.blob && await BlobIntegrity.isIntact(identifier, local.blob)) return local;
    if (local?.blob) {
      this.resources.delete(identifier);
      await this.db.delete(identifier);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch('/api/media/model/' + identifier, { signal: controller.signal });
      if (response.ok && Number(response.headers.get('content-length') || 0) <= ModelStorage.MAX_BYTES) {
        const blob = await response.blob();
        const filename = name || local?.name || decodeURIComponent(response.headers.get('x-file-name') || '');
        return await this.accept({ identifier, name: filename, kind: ModelStorage.kind(filename), size: blob.size, blob });
      }
    } catch (error) { Logger.debug('[ModelStorage] HTTP unavailable; trying peers', error); }
    finally { clearTimeout(timer); }
    const candidates = Array.from(this.providers.get(identifier) || []).filter(peer => Network.peerIds.includes(peer));
    if (!candidates.length) candidates.push(...Network.peerIds.filter(peer => peer !== Network.peerId));
    for (const peer of candidates.slice(0, 8)) {
      const result = await new Promise<ModelResource>(resolve => {
        const requestId = UUID.generateUuid();
        let finished = false;
        const timeout = setTimeout(() => finish(null), 90000);
        const finish = (file: ModelResource) => {
          if (finished) return;
          finished = true;
          clearTimeout(timeout);
          const task = this.requests.get(requestId)?.task;
          this.requests.delete(requestId);
          if (task) task.cancel();
          resolve(file);
        };
        this.requests.set(requestId, { identifier, peer, started: () => clearTimeout(timeout), resolve: finish });
        EventSystem.call('REQUEST_MODEL3D', { identifier, requestId }, peer);
      });
      if (result) return result;
    }
    return null;
  }

  private async send(identifier: string, requestId: string, peer: string) {
    const epoch = this.roomEpoch;
    await this.ready;
    const file = this.resources.get(identifier);
    if (!this.shared.has(identifier) || !file?.blob || this.transfers.size >= 6 || !(await BlobIntegrity.isIntact(identifier, file.blob))) {
      EventSystem.call('MODEL3D_UNAVAILABLE', { identifier, requestId }, peer);
      return;
    }
    const taskIdentifier = 'model3d-' + requestId;
    const bytes = new Uint8Array(await file.blob.arrayBuffer());
    if (epoch !== this.roomEpoch || !this.shared.has(identifier)) return;
    const task = BufferSharingTask.createSendTask<Uint8Array>(taskIdentifier, peer);
    this.transfers.add(task);
    task.onfinish = () => this.transfers.delete(task);
    EventSystem.call('START_MODEL3D', { ...this.metadata(file), requestId, taskIdentifier }, peer);
    task.start(bytes);
  }

  async upload(file: ModelResource): Promise<void> {
    const pending = this.uploading.get(file.identifier);
    if (pending) return pending;
    const work = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 60000);
      try {
        const url = '/api/media/model/' + file.identifier;
        if ((await fetch(url, { method: 'HEAD', signal: controller.signal })).ok) return;
        const response = await fetch(url, { method: 'PUT', body: file.blob, signal: controller.signal,
          headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) } });
        if (!response.ok) Logger.warn('[ModelStorage] model remains in local cache/P2P; server upload failed', response.status);
      } catch (error) { Logger.warn('[ModelStorage] model remains in local cache/P2P', error); }
      finally { clearTimeout(timer); }
    })().finally(() => this.uploading.delete(file.identifier));
    this.uploading.set(file.identifier, work);
    return work;
  }

  async remove(identifier: string): Promise<void> {
    this.resources.delete(identifier);
    this.shared.delete(identifier);
    await this.db.delete(identifier);
    this.changed();
  }
}
