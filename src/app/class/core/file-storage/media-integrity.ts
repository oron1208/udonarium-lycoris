import { EventSystem } from '../system';
import { ImageState } from './image-file';
import { ImageStorage } from './image-storage';

export type MediaIntegrityStatus = 'ok' | 'local-only' | 'missing';

export interface MediaIntegrityItem {
  readonly identifier: string;
  readonly name: string;
  readonly status: MediaIntegrityStatus;
}

export interface MediaIntegritySummary {
  readonly total: number;
  readonly ok: number;
  readonly localOnly: number;
  readonly missing: number;
  readonly items: MediaIntegrityItem[];
}

/**
 * 部屋のメディア（SHA-256ハッシュ識別子の画像）について
 * 「サーバー保持 × この端末のローカル保持」の2軸から整合状態を集計する。
 *
 * - ok         : サーバーに存在し同期済み
 * - local-only : サーバーには無いが自分がblob完全所持（再PUT候補＝ホルダー）
 * - missing    : サーバーにもローカルblobにも無い（画面に壊れた画像が出る状態）
 */
export class MediaIntegrity {
  private static _instance: MediaIntegrity;
  static get instance(): MediaIntegrity {
    if (!MediaIntegrity._instance) MediaIntegrity._instance = new MediaIntegrity();
    return MediaIntegrity._instance;
  }

  private initialized = false;
  private lastSummary: MediaIntegritySummary = { total: 0, ok: 0, localOnly: 0, missing: 0, items: [] };

  private constructor() { }

  initialize() {
    if (this.initialized) return;
    this.initialized = true;
    EventSystem.register(this)
      .on('SERVER_MEDIA_MISSING', () => this.refresh())
      .on('UPDATE_FILE_RESOURE', () => this.refresh())
      .on('IMAGE_FILE_CHANGED', () => this.refresh())
      .on('SYNCHRONIZE_FILE_LIST', () => this.refresh())
      .on('MEDIA_REPLENISHED', () => this.refresh())
      .on('CONNECT_PEER', () => setTimeout(() => this.refresh(), 3000));
  }

  destroy() {
    if (!this.initialized) return;
    this.initialized = false;
    EventSystem.unregister(this);
  }

  /** 現在のカタログとmissingOnServerから再集計し、変化があればMEDIA_INTEGRITY_CHANGEDを発火する */
  refresh(): MediaIntegritySummary {
    const summary = this.summarize();
    const prev = this.lastSummary;
    const changed = prev.total !== summary.total || prev.ok !== summary.ok
      || prev.localOnly !== summary.localOnly || prev.missing !== summary.missing;
    this.lastSummary = summary;
    if (changed) {
      EventSystem.trigger('MEDIA_INTEGRITY_CHANGED', summary);
    }
    return summary;
  }

  get summary(): MediaIntegritySummary {
    return this.lastSummary;
  }

  private summarize(): MediaIntegritySummary {
    const storage = ImageStorage.instance;
    const items: MediaIntegrityItem[] = [];
    let ok = 0, localOnly = 0, missing = 0;
    for (const image of storage.images) {
      // サーバー管理対象（SHA-256ハッシュ識別子）だけが整合管理の対象（URL画像は除外）
      if (!/^[a-f0-9]{64}$/i.test(image.identifier)) continue;
      if (!storage.missingOnServer.has(image.identifier)) {
        ok++;
        items.push({ identifier: image.identifier, name: image.name, status: 'ok' });
      } else if (ImageState.COMPLETE <= image.state && image.state < ImageState.URL && image.blob) {
        localOnly++;
        items.push({ identifier: image.identifier, name: image.name, status: 'local-only' });
      } else {
        missing++;
        items.push({ identifier: image.identifier, name: image.name, status: 'missing' });
      }
    }
    items.sort((a, b) => a.status.localeCompare(b.status) || a.identifier.localeCompare(b.identifier));
    return { total: items.length, ok, localOnly, missing, items };
  }
}
