import { Injectable } from '@angular/core';
import { Config } from '@udonarium/config';
import { Logger } from '../class/core/system/util/logger';

export interface ServerAudioTrack {
  id: string;
  name: string;
  category: string;
  url: string;
  duration: number;
}

interface AudioLibraryCache {
  tracks: ServerAudioTrack[];
  fetchedAt: number;
}

@Injectable({
  providedIn: 'root'
})
export class AudioLibraryService {
  private cache: AudioLibraryCache = { tracks: [], fetchedAt: 0 };
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5分

  private _baseUrl: string = '';

  constructor() {
    // ベースURLを実環境に合わせて設定
    // VPSデプロイ時は同じオリジン、ローカル開発時はVPSを直接参照
    this._baseUrl = this.detectBaseUrl();
  }

  private detectBaseUrl(): string {
    // ローカル開発環境（localhost / 192.168.x.x）の場合はVPSを参照
    const host = window.location.hostname;
    if (host === 'localhost' || host.startsWith('192.168.') || host.startsWith('127.')) {
      return 'https://udonarium-lycoris.ddns.net';
    }
    // 本番環境は同じオリジン
    return '';
  }

  get baseUrl(): string { return this._baseUrl; }

  get tracks(): ServerAudioTrack[] {
    return this.cache.tracks;
  }

  get categories(): string[] {
    const set = new Set<string>();
    for (const track of this.cache.tracks) {
      set.add(track.category);
    }
    return [...set].sort();
  }

  getTrack(id: string): ServerAudioTrack | null {
    return this.cache.tracks.find(t => t.id === id) || null;
  }

  getTrackUrl(id: string): string | null {
    const track = this.getTrack(id);
    if (!track) return null;
    return this._baseUrl + track.url;
  }

  /**
   * アップロード音声のサーバーURLを解決
   * identifierはSHA-256ハッシュ
   */
  getUploadAudioUrl(identifier: string): string {
    return this._baseUrl + '/api/media/audio/' + identifier;
  }

  get isReady(): boolean {
    return Date.now() - this.cache.fetchedAt < this.CACHE_TTL && this.cache.tracks.length > 0;
  }

  async fetchTracks(force: boolean = false): Promise<ServerAudioTrack[]> {
    if (!force && this.isReady) {
      return this.cache.tracks;
    }

    try {
      const url = this._baseUrl + '/api/audio-library';
      const response = await fetch(url);
      if (!response.ok) {
        Logger.warn('[AudioLibrary] fetch failed:', response.status);
        return this.cache.tracks;
      }
      const data = await response.json();
      this.cache = {
        tracks: Array.isArray(data.tracks) ? data.tracks : [],
        fetchedAt: Date.now()
      };
      Logger.debug(`[AudioLibrary] fetched ${this.cache.tracks.length} tracks`);
      return this.cache.tracks;
    } catch (error) {
      Logger.warn('[AudioLibrary] fetch error:', error);
      return this.cache.tracks;
    }
  }

  search(query: string): ServerAudioTrack[] {
    if (!query.trim()) return this.cache.tracks;
    const lower = query.toLowerCase();
    return this.cache.tracks.filter(t =>
      t.name.toLowerCase().includes(lower) ||
      t.category.toLowerCase().includes(lower)
    );
  }

  filterByCategory(category: string): ServerAudioTrack[] {
    if (!category || category === 'すべて') return this.cache.tracks;
    return this.cache.tracks.filter(t => t.category === category);
  }
}
