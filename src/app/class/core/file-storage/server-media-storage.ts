import { EventSystem } from '../system';
import { AudioFile } from './audio-file';
import { ImageFile } from './image-file';
import { Logger } from '../system/util/logger';
import { MediaLoadPriority, MediaPriority } from './media-load-priority';

/**
 * サーバー fetch の結果を「本当に無い」「サーバー障害」「取得成功」で区別する。
 * in-flight(並行 fetch)は同じ Promise を共有するため、ここでは現れない。
 */
export type FetchResult<T = ImageFile | AudioFile> =
  | { status: 'ok'; file: T }
  | { status: 'missing' }     // 404: サーバーには本当に存在しない
  | { status: 'unreachable' }; // ネットワークエラー/5xx: サーバーが応答しない

type RawFetchResult =
  | { status: 'ok'; blob: Blob; name?: string }
  | { status: 'missing' }
  | { status: 'unreachable' };

export type MediaBundleEntry = {
  kind: 'image' | 'audio';
  hash: string;
  name?: string;
  type?: string;
  size?: number;
};

export type MediaBundleProgress = {
  total: number;
  done: number;
  loaded: number;
};

export type MediaBundleResult = {
  requested: number;
  loaded: number;
  missing: MediaBundleEntry[];
  failed: MediaBundleEntry[];
};

export class ServerMediaStorage {
  private static uploading: Set<string> = new Set();
  /** サーバーに存在確認済みのidentifier（HEADリクエストを省略するためのキャッシュ） */
  private static knownOnServer: Set<string> = new Set();
  /** in-flight fetch を Promise 共有で dedup する(同ID並行fetchの2個目が即失敗扱いになるバグ防止) */
  private static fetching: Map<string, Promise<RawFetchResult>> = new Map();
  private static missingNotified: Set<string> = new Set();

  /** サーバー生死キャッシュ(/health)。連続fetchのたびに叩かないため */
  private static serverAlive: boolean = true;
  private static aliveCheckedAt: number = 0;
  private static readonly ALIVE_TTL_MS = 30_000;

  static async uploadImage(image: ImageFile): Promise<void> {
    const context = image.toContext();
    if (!context || !context.identifier || !context.blob) return;
    await this.upload('image', context.identifier, context.blob, context.name);
  }

  static async uploadAudio(audio: AudioFile): Promise<void> {
    const context = audio.toContext();
    if (!context || !context.identifier || !context.blob) return;
    await this.upload('audio', context.identifier, context.blob, context.name);
  }

  /** 画像を取得。戻り値で「成功/不在/サーバー障害」を区別する。in-flight なら同じ Promise を待つ。 */
  static async fetchImage(identifier: string, priority: MediaPriority = 'auto'): Promise<FetchResult<ImageFile>> {
    const raw = await this.fetchBlob('image', identifier, priority);
    return this.toFetchResult<ImageFile>(raw, async blob => this.createServerImage(
      identifier,
      blob,
      raw.status === 'ok' ? raw.name : undefined,
    ));
  }

  /** 音声を取得。戻り値で「成功/不在/サーバー障害」を区別する。in-flight なら同じ Promise を待つ。 */
  static async fetchAudio(identifier: string, priority: MediaPriority = 'auto'): Promise<FetchResult<AudioFile>> {
    const raw = await this.fetchBlob('audio', identifier, priority);
    return this.toFetchResult<AudioFile>(raw, async blob => this.createServerAudio(
      identifier,
      blob,
      raw.status === 'ok' ? raw.name : undefined,
    ));
  }

  /**
   * Fetch all media needed by an initial room snapshot in one HTTP ZIP.
   * Entries are expanded and registered one at a time. Their server-side
   * SHA-256 name is already verified, so joining clients avoid re-hashing and
   * thumbnail generation, which previously decoded and copied every image.
   */
  static async fetchBundle(
    imageIdentifiers: string[],
    audioIdentifiers: string[],
    onProgress?: (progress: MediaBundleProgress) => void,
  ): Promise<MediaBundleResult> {
    const images = this.validIdentifiers(imageIdentifiers, 4096);
    const audios = this.validIdentifiers(audioIdentifiers, Math.max(0, 4096 - images.length));
    const requested = images.length + audios.length;
    const empty: MediaBundleResult = { requested, loaded: 0, missing: [], failed: [] };
    if (requested < 1) return empty;

    // Keep high-value table assets at the start of the archive/extraction order.
    const orderedImages = MediaLoadPriority.sortByScore(
      images.map(identifier => ({ identifier })),
      MediaLoadPriority.getImageScoreMap(),
    ).map(item => item.identifier);
    const orderedAudios = MediaLoadPriority.sortByScore(
      audios.map(identifier => ({ identifier })),
      MediaLoadPriority.getAudioScoreMap(),
    ).map(item => item.identifier);

    const response = await fetch('/api/media/bundle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ images: orderedImages, audios: orderedAudios }),
    });
    if (!response.ok) throw new Error(`Media bundle request failed: HTTP ${response.status}`);
    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    if (!contentType.includes('application/zip')) throw new Error('Media bundle response is not a ZIP archive');

    const maxArchiveBytes = 192 * 1024 * 1024;
    const announcedBytes = Number(response.headers.get('x-media-bundle-bytes'));
    const announcedEntries = Number(response.headers.get('x-media-bundle-entries'));
    if (!Number.isSafeInteger(announcedBytes) || announcedBytes < 0 || maxArchiveBytes < announcedBytes
      || !Number.isSafeInteger(announcedEntries) || announcedEntries < 0 || requested < announcedEntries) {
      if (response.body) await response.body.cancel().catch(() => { });
      throw new Error('Media bundle headers exceed safe limits');
    }
    const archiveBlob = await response.blob();
    if (archiveBlob.size > maxArchiveBytes + 2 * 1024 * 1024) throw new Error('Media bundle is too large');

    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(archiveBlob, { createFolders: false });
    const manifestFile = zip.file('_manifest.json');
    if (!manifestFile || Number((manifestFile as any)?._data?.uncompressedSize || 0) > 4 * 1024 * 1024) {
      throw new Error('Media bundle manifest is missing or too large');
    }
    const manifestText = await manifestFile.async('text');
    if (manifestText.length > 4 * 1024 * 1024) throw new Error('Media bundle manifest is too large');

    const manifest = JSON.parse(manifestText) || {};
    const requestedKeys = new Set<string>();
    for (const identifier of images) requestedKeys.add(`image:${identifier}`);
    for (const identifier of audios) requestedKeys.add(`audio:${identifier}`);

    const rawEntries: any[] = Array.isArray(manifest.entries) ? manifest.entries : [];
    const rawMissing: any[] = Array.isArray(manifest.missing) ? manifest.missing : [];
    if (manifest.version !== 1 || manifest.requested !== requested
      || rawEntries.length !== announcedEntries
      || rawEntries.length + rawMissing.length !== requested
      || rawEntries.length > 4096 || rawMissing.length > 4096) {
      throw new Error('Media bundle manifest counts are invalid');
    }

    const entries: MediaBundleEntry[] = [];
    const missing: MediaBundleEntry[] = [];
    const manifestKeys = new Set<string>();
    let declaredTotalBytes = 0;
    for (const rawEntry of rawEntries) {
      const entry = this.normalizeBundleEntry(rawEntry);
      const key = entry ? `${entry.kind}:${entry.hash}` : '';
      if (!entry || !requestedKeys.has(key) || manifestKeys.has(key)
        || !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > 100 * 1024 * 1024) {
        throw new Error('Media bundle entry metadata is invalid');
      }
      manifestKeys.add(key);
      declaredTotalBytes += entry.size;
      if (!Number.isSafeInteger(declaredTotalBytes) || maxArchiveBytes < declaredTotalBytes) {
        throw new Error('Media bundle expands beyond the client limit');
      }
      entries.push(entry);
    }
    for (const rawEntry of rawMissing) {
      const entry = this.normalizeBundleEntry(rawEntry);
      const key = entry ? `${entry.kind}:${entry.hash}` : '';
      if (!entry || !requestedKeys.has(key) || manifestKeys.has(key)) {
        throw new Error('Media bundle missing-entry metadata is invalid');
      }
      manifestKeys.add(key);
      missing.push(entry);
    }
    if (manifestKeys.size !== requestedKeys.size
      || manifest.totalBytes !== declaredTotalBytes
      || announcedBytes !== declaredTotalBytes) {
      throw new Error('Media bundle manifest totals are invalid');
    }

    const archiveFiles = Object.keys(zip.files)
      .map(name => zip.files[name])
      .filter(file => !file.dir);
    if (archiveFiles.length !== entries.length + 1
      || !archiveFiles.every(file => file.name === '_manifest.json'
        || manifestKeys.has(file.name.replace('/', ':')))) {
      throw new Error('Media bundle contains unlisted ZIP entries');
    }
    for (const entry of entries) {
      const zipEntry = zip.file(`${entry.kind}/${entry.hash}`);
      const size = Number((zipEntry as any)?._data?.uncompressedSize);
      if (!zipEntry || !Number.isSafeInteger(size) || size !== entry.size) {
        throw new Error('Media bundle ZIP sizes do not match the manifest');
      }
    }

    const [{ ImageStorage }, { AudioStorage }] = await Promise.all([
      import('./image-storage'),
      import('./audio-storage'),
    ]);

    const failed: MediaBundleEntry[] = [];
    let loaded = 0;
    let done = 0;
    onProgress?.({ total: entries.length, done, loaded });

    let loadedBytes = 0;
    for (const entry of entries) {
      const entryPath = `${entry.kind}/${entry.hash}`;
      const zipEntry = zip.file(entryPath);
      const declaredSize = Number(entry.size || 0);

      try {
        const rawBlob = await zipEntry.async('blob');
        if (declaredSize > 0 && rawBlob.size !== declaredSize) throw new Error('Media bundle entry size mismatch');
        loadedBytes += rawBlob.size;
        if (maxArchiveBytes < loadedBytes) throw new Error('Media bundle expanded beyond the client limit');
        const blob = entry.type ? new Blob([rawBlob], { type: entry.type }) : rawBlob;
        this.knownOnServer.add(entry.hash);
        if (entry.kind === 'image') {
          ImageStorage.instance.add(this.createServerImage(entry.hash, blob, entry.name));
        } else {
          AudioStorage.instance.add(this.createServerAudio(entry.hash, blob, entry.name));
        }
        loaded++;
      } catch (error) {
        failed.push(entry);
        Logger.warn(`[media-bundle] failed to load ${entryPath}`, error);
      } finally {
        zip.remove(entryPath);
      }

      done++;
      onProgress?.({ total: entries.length, done, loaded });
      if (done % 4 === 0) await new Promise<void>(resolve => setTimeout(resolve, 0));
    }

    return {
      requested,
      loaded,
      missing,
      failed,
    };
  }

  /** blob が取得できた場合のみファイル化。在/不在/障害の区別なし(従来互換のキャッシュミス埋め用)。 */
  static async fetchImageOrNull(identifier: string): Promise<ImageFile | null> {
    const result = await this.fetchImage(identifier);
    return result.status === 'ok' ? result.file : null;
  }

  static async fetchAudioOrNull(identifier: string): Promise<AudioFile | null> {
    const result = await this.fetchAudio(identifier);
    return result.status === 'ok' ? result.file : null;
  }

  private static async toFetchResult<T>(
    raw: RawFetchResult,
    factory: (blob: Blob) => Promise<T>,
  ): Promise<FetchResult<T>> {
    if (raw.status === 'ok') {
      try {
        const file = await factory(raw.blob);
        return { status: 'ok', file };
      } catch (error) {
        // blob は取れたがファイル化(画像デコード等)に失敗 → 在とみなして扱えないので不在扱い
        Logger.warn('media file factory failed', error);
        return { status: 'missing' };
      }
    }
    return raw;
  }

  private static createServerImage(identifier: string, blob: Blob, name?: string): ImageFile {
    return ImageFile.create({
      identifier,
      name: name || identifier,
      type: blob.type || 'image/*',
      blob,
      url: '',
      thumbnail: { blob: null, type: '', url: '' },
    });
  }

  private static createServerAudio(identifier: string, blob: Blob, name?: string): AudioFile {
    return AudioFile.create({
      identifier,
      name: name || identifier,
      type: blob.type || 'audio/*',
      blob,
      url: '',
    });
  }

  private static validIdentifiers(identifiers: string[], maxItems: number = 4096): string[] {
    if (maxItems < 1) return [];
    const valid = new Set<string>();
    for (const value of identifiers || []) {
      const identifier = String(value || '').toLowerCase();
      if (/^[a-f0-9]{64}$/.test(identifier)) valid.add(identifier);
      if (valid.size >= maxItems) break;
    }
    return Array.from(valid);
  }

  private static normalizeBundleEntry(value: any): MediaBundleEntry | null {
    if (!value || (value.kind !== 'image' && value.kind !== 'audio')) return null;
    const hash = String(value.hash || '').toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(hash)) return null;
    return {
      kind: value.kind,
      hash,
      name: typeof value.name === 'string' ? value.name : hash,
      type: typeof value.type === 'string' ? value.type : '',
      size: Number.isFinite(Number(value.size)) ? Number(value.size) : 0,
    };
  }

  private static async upload(kind: 'image' | 'audio', identifier: string, blob: Blob, name?: string): Promise<void> {
    const key = `${kind}:${identifier}`;
    if (this.uploading.has(key)) return;
    this.uploading.add(key);
    try {
      // キャッシュ済みならスキップ
      if (this.knownOnServer.has(identifier)) {
        Logger.debug(`[media] skip upload ${kind}:${identifier} (cached)`);
        return;
      }
      // サーバーに既存かチェック（HEADリクエスト）
      // 既にある場合はアップロードをスキップして通信量を節約
      const checkUrl = `/api/media/${kind}/${encodeURIComponent(identifier)}`;
      const headResp = await fetch(checkUrl, { method: 'HEAD' });
      if (headResp.ok) {
        this.knownOnServer.add(identifier);
        Logger.debug(`[media] skip upload ${kind}:${identifier} (already on server)`);
        return;
      }

      const uploadUrl = checkUrl;
      const uploadHeaders = {
        'Content-Type': blob.type || 'application/octet-stream',
        'X-File-Name': encodeURIComponent(name || identifier),
      };
      // Try PUT first, fall back to POST for servers that reject PUT (e.g. shared hosting)
      let response = await fetch(uploadUrl, { method: 'PUT', headers: uploadHeaders, body: blob });
      if (response.status === 405) {
        response = await fetch(uploadUrl, { method: 'POST', headers: uploadHeaders, body: blob });
      }
      if (!response.ok && response.status !== 409) Logger.warn(`media upload failed ${kind}:${identifier}`, response.status, await response.text().catch(() => ''));
      else this.knownOnServer.add(identifier);
    } catch (error) {
      Logger.warn(`media upload failed ${kind}:${identifier}`, error);
    } finally {
      this.uploading.delete(key);
    }
  }

  /**
   * サーバーからメディアを取得。in-flight なら同じ Promise を共有する。
   * 404 = missing、ネットワークエラー/5xx = unreachable、200 = ok。
   */
  private static fetchBlob(kind: 'image' | 'audio', identifier: string, priority: MediaPriority = 'auto'): Promise<RawFetchResult> {
    const key = `${kind}:${identifier}`;
    const inflight = this.fetching.get(key);
    if (inflight) return inflight;

    const promise = (async(): Promise<RawFetchResult> => {
      try {
        const response = await fetch(
          `/api/media/${kind}/${encodeURIComponent(identifier)}`,
          priority === 'auto' ? undefined : ({ priority } as RequestInit & { priority: MediaPriority })
        );
        if (response.ok) {
          this.knownOnServer.add(identifier);
          const name = this.extractFileName(response);
          return { status: 'ok', blob: await response.blob(), name };
        }
        if (response.status === 404) {
          this.notifyMissing(kind, identifier);
          return { status: 'missing' };
        }
        // 5xx 等はサーバー障害の可能性
        this.markServerDead();
        return { status: 'unreachable' };
      } catch (error) {
        // ネットワークエラー(DNS拒否/接続拒否/CORS/タイムアウト)= サーバー障害
        Logger.warn(`media fetch failed ${kind}:${identifier}`, error);
        this.markServerDead();
        return { status: 'unreachable' };
      } finally {
        this.fetching.delete(key);
      }
    })();

    this.fetching.set(key, promise);
    return promise;
  }

  /** レスポンスヘッダーからファイル名を抽出 */
  private static extractFileName(response: Response): string | undefined {
    const raw = response.headers.get('X-File-Name');
    if (!raw) return undefined;
    try { return decodeURIComponent(raw); } catch { return raw; }
  }

  /**
   * サーバーが生存しているか(過去 ALIVE_TTL_MS 以内のキャッシュ付き)。
   * サーバー死検出後は即 false、復活確認は次の TTL 切れで再チェック。
   */
  static async isServerAlive(): Promise<boolean> {
    const now = Date.now();
    if (now - this.aliveCheckedAt < this.ALIVE_TTL_MS) return this.serverAlive;
    this.aliveCheckedAt = now;
    try {
      const response = await fetch('/health');
      this.serverAlive = response.ok;
    } catch (error) {
      this.serverAlive = false;
    }
    return this.serverAlive;
  }

  /** fetch 失敗時に即座にキャッシュを「死」にする(次の TTL まで無駄な試行を省く) */
  private static markServerDead(): void {
    this.serverAlive = false;
    this.aliveCheckedAt = Date.now();
  }

  private static notifyMissing(kind: 'image' | 'audio', identifier: string) {
    const key = `${kind}:${identifier}`;
    if (this.missingNotified.has(key)) return;
    this.missingNotified.add(key);
    EventSystem.trigger('SERVER_MEDIA_MISSING', { kind, identifier });
  }
}
