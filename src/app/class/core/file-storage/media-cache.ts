import { Database } from '../../database/database';
import { Logger } from '../system/util/logger';
import { AudioFile, AudioState } from './audio-file';
import { ImageFile, ImageState } from './image-file';
import { MediaPriority } from './media-load-priority';
import { FetchResult, ServerMediaStorage } from './server-media-storage';

interface CachedImage {
  identifier: string;
  name: string;
  type: string;
  blob: Blob;
  thumbBlob: Blob | null;
  thumbType: string;
  savedAt: number;
}

interface CachedAudio {
  identifier: string;
  name: string;
  type: string;
  blob: Blob;
  savedAt: number;
}

/**
 * メディア（画像・音声）のIndexedDB永続キャッシュ。
 *
 * - identifierはSHA-256（内容不変）なので、サーバー側で削除されていても
 *   キャッシュを安全に再利用できる（無効化は不要。容量管理は後続タスク）。
 * - 「再訪（リロード後の再入室）」時にメディアをネットワーク再取得せず、
 *   IndexedDBから即時復元する（弱回線・再訪の軽量化。redesign文書 Layer 2）。
 * - 保存・復元の失敗は動作に影響させない（常にHTTP/P2P取得にフォールバック）。
 */
export class MediaCache {
  private static _imageDb: Database<CachedImage> | null = null;
  private static _audioDb: Database<CachedAudio> | null = null;
  private static restoringImage: Map<string, Promise<ImageFile | null>> = new Map();
  private static restoringAudio: Map<string, Promise<AudioFile | null>> = new Map();
  /** このセッションで保存済みのidentifier（重複書き込み防止） */
  private static savedIdentifiers: Set<string> = new Set();

  private static get imageDb(): Database<CachedImage> {
    if (!MediaCache._imageDb) MediaCache._imageDb = new Database<CachedImage>('MediaCacheImage');
    return MediaCache._imageDb;
  }

  private static get audioDb(): Database<CachedAudio> {
    if (!MediaCache._audioDb) MediaCache._audioDb = new Database<CachedAudio>('MediaCacheAudio');
    return MediaCache._audioDb;
  }

  /** COMPLETE画像を永続キャッシュへ保存（URL画像は対象外・失敗は無視） */
  static async cacheImage(file: ImageFile): Promise<void> {
    try {
      const identifier = file?.identifier || '';
      if (MediaCache.savedIdentifiers.has(identifier)) return;
      if (!/^[a-f0-9]{64}$/i.test(identifier)) return;
      if (file.state >= ImageState.URL) return;
      const blob = file.context.blob;
      if (!blob || blob.size === 0) return;
      // サムネイルは空blobをnullに正規化（Safari/iOSのIndexedDBクラッシュ時に空blobが混入する事故への防御）
      const thumbBlob = file.context.thumbnail.blob && file.context.thumbnail.blob.size > 0 ? file.context.thumbnail.blob : null;
      const entry: CachedImage = {
        identifier,
        name: file.name,
        type: file.context.type,
        blob,
        thumbBlob,
        thumbType: file.context.thumbnail.type,
        savedAt: Date.now(),
      };
      await MediaCache.imageDb.put(identifier, entry);
      MediaCache.savedIdentifiers.add(identifier);
      Logger.debug(`[MediaCache] cached image ${identifier.slice(0, 12)}`);
    } catch (e) {
      Logger.warn('[MediaCache] cacheImage failed', e);
    }
  }

  /** COMPLETE音声を永続キャッシュへ保存（失敗は無視） */
  static async cacheAudio(file: AudioFile): Promise<void> {
    try {
      const identifier = file?.identifier || '';
      if (MediaCache.savedIdentifiers.has(identifier)) return;
      if (!/^[a-f0-9]{64}$/i.test(identifier)) return;
      if (file.state >= AudioState.URL) return;
      if (!file.blob || file.blob.size === 0) return;
      const entry: CachedAudio = {
        identifier,
        name: file.name,
        type: file.blob.type,
        blob: file.blob,
        savedAt: Date.now(),
      };
      await MediaCache.audioDb.put(identifier, entry);
      MediaCache.savedIdentifiers.add(identifier);
      Logger.debug(`[MediaCache] cached audio ${identifier.slice(0, 12)}`);
    } catch (e) {
      Logger.warn('[MediaCache] cacheAudio failed', e);
    }
  }

  private static restoreImage(identifier: string): Promise<ImageFile | null> {
    const inFlight = MediaCache.restoringImage.get(identifier);
    if (inFlight) return inFlight;
    const promise = (async () => {
      try {
        const entry = await MediaCache.imageDb.get(identifier);
        if (!entry) return null;
        if (!entry.blob || entry.blob.size === 0) {
          // クラッシュ等で空のまま保存された破損キャッシュを削除し、サーバー再取得にフォールバックする（自己修復）
          await MediaCache.imageDb.delete(identifier).catch(() => undefined);
          Logger.warn(`[MediaCache] purged broken image cache ${identifier.slice(0, 12)} (empty blob)`);
          return null;
        }
        const image = ImageFile.create({
          identifier: entry.identifier,
          name: entry.name,
          type: entry.type,
          blob: entry.blob,
          url: '',
          thumbnail: { blob: entry.thumbBlob && entry.thumbBlob.size > 0 ? entry.thumbBlob : null, type: entry.thumbType, url: '' },
        });
        Logger.debug(`[MediaCache] restored image ${identifier.slice(0, 12)}`);
        return image;
      } catch (e) {
        Logger.warn('[MediaCache] restoreImage failed', e);
        return null;
      } finally {
        MediaCache.restoringImage.delete(identifier);
      }
    })();
    MediaCache.restoringImage.set(identifier, promise);
    return promise;
  }

  private static restoreAudio(identifier: string): Promise<AudioFile | null> {
    const inFlight = MediaCache.restoringAudio.get(identifier);
    if (inFlight) return inFlight;
    const promise = (async () => {
      try {
        const entry = await MediaCache.audioDb.get(identifier);
        if (!entry) return null;
        if (!entry.blob || entry.blob.size === 0) {
          await MediaCache.audioDb.delete(identifier).catch(() => undefined);
          Logger.warn(`[MediaCache] purged broken audio cache ${identifier.slice(0, 12)} (empty blob)`);
          return null;
        }
        const audio = AudioFile.create({
          identifier: entry.identifier,
          name: entry.name,
          type: entry.type,
          blob: entry.blob,
          url: '',
        });
        Logger.debug(`[MediaCache] restored audio ${identifier.slice(0, 12)}`);
        return audio;
      } catch (e) {
        Logger.warn('[MediaCache] restoreAudio failed', e);
        return null;
      } finally {
        MediaCache.restoringAudio.delete(identifier);
      }
    })();
    MediaCache.restoringAudio.set(identifier, promise);
    return promise;
  }

  /** 永続キャッシュを優先して画像を取得。キャッシュに無ければサーバーから取得する */
  static async fetchImageWithCache(identifier: string, priority: MediaPriority = 'auto'): Promise<FetchResult<ImageFile>> {
    if (!/^[a-f0-9]{64}$/i.test(identifier || '')) return ServerMediaStorage.fetchImage(identifier, priority);
    const restored = await MediaCache.restoreImage(identifier);
    if (restored) return { status: 'ok', file: restored };
    return ServerMediaStorage.fetchImage(identifier, priority);
  }

  /** 永続キャッシュを優先して音声を取得。キャッシュに無ければサーバーから取得する */
  static async fetchAudioWithCache(identifier: string, priority: MediaPriority = 'auto'): Promise<FetchResult<AudioFile>> {
    if (!/^[a-f0-9]{64}$/i.test(identifier || '')) return ServerMediaStorage.fetchAudio(identifier, priority);
    const restored = await MediaCache.restoreAudio(identifier);
    if (restored) return { status: 'ok', file: restored };
    return ServerMediaStorage.fetchAudio(identifier, priority);
  }
}
