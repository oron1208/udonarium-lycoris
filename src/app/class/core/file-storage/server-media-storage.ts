import { EventSystem } from '../system';
import { AudioFile } from './audio-file';
import { ImageFile } from './image-file';
import { Logger } from '../system/util/logger';
import { MediaPriority } from './media-load-priority';

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
    return this.toFetchResult<ImageFile>(raw, async blob => {
      if (raw.status === 'ok' && raw.name) {
        return await ImageFile.createAsync(blob, raw.name);
      }
      return await ImageFile.createAsync(blob);
    });
  }

  /** 音声を取得。戻り値で「成功/不在/サーバー障害」を区別する。in-flight なら同じ Promise を待つ。 */
  static async fetchAudio(identifier: string, priority: MediaPriority = 'auto'): Promise<FetchResult<AudioFile>> {
    const raw = await this.fetchBlob('audio', identifier, priority);
    return this.toFetchResult<AudioFile>(raw, async blob => {
      if (raw.status === 'ok' && raw.name) {
        return await AudioFile.createAsync(blob, raw.name);
      }
      return await AudioFile.createAsync(blob);
    });
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
