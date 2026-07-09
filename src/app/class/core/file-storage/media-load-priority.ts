import { ObjectStore } from '../synchronize-object/object-store';

export type MediaPriority = 'high' | 'auto' | 'low';

export interface PriorityCatalogItem {
  readonly identifier: string;
}

const HASH_IDENTIFIER = /^[a-f0-9]{64}$/i;

/**
 * 入室直後のメディア取得を「今見える/鳴っているもの」から優先するための軽量スコアラー。
 * ObjectStore に同期済みの情報だけを使い、未同期・未参照のものは低優先度のまま後回しにする。
 */
export class MediaLoadPriority {
  static readonly VISIBLE_IMAGE_SCORE = 80;
  static readonly ACTIVE_AUDIO_SCORE = 80;

  static getImageScoreMap(): Map<string, number> {
    return this.collectScores('image');
  }

  static getAudioScoreMap(): Map<string, number> {
    return this.collectScores('audio');
  }

  static sortByScore<T extends PriorityCatalogItem>(items: T[], scores: Map<string, number>): T[] {
    return items
      .map((item, index) => ({ item, index, score: this.scoreOf(scores, item.identifier) }))
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .map(entry => entry.item);
  }

  static scoreOf(scores: Map<string, number>, identifier: string): number {
    return scores.get(identifier) || 0;
  }

  static fetchPriority(score: number, highThreshold: number): MediaPriority {
    if (score >= highThreshold) return 'high';
    if (score <= 0) return 'low';
    return 'auto';
  }

  private static collectScores(kind: 'image' | 'audio'): Map<string, number> {
    const scores = new Map<string, number>();
    const objects = ObjectStore.instance.getObjects<any>();

    for (const object of objects) {
      const context = this.safeContext(object);
      const aliasName = String((context && context.aliasName) || object?.aliasName || '');
      const syncData = (context && context.syncData) || {};
      const objectScore = kind === 'image'
        ? this.imageObjectScore(object, aliasName, syncData)
        : this.audioObjectScore(aliasName, syncData);

      this.walk(syncData, (value, path) => {
        if (typeof value !== 'string') return;
        const identifier = this.normalizeIdentifier(kind, value);
        if (!identifier) return;

        const keyPath = path.join('.');
        const score = kind === 'image'
          ? Math.max(objectScore, this.imagePathScore(object, aliasName, syncData, keyPath))
          : Math.max(objectScore, this.audioPathScore(aliasName, syncData, keyPath));
        this.addScore(scores, identifier, score);
      });
    }

    return scores;
  }

  private static safeContext(object: any): any {
    try { return object && typeof object.toContext === 'function' ? object.toContext() : null; }
    catch { return null; }
  }

  private static normalizeIdentifier(kind: 'image' | 'audio', value: string): string {
    if (!value) return '';
    if (kind === 'audio' && value.startsWith('server:')) return '';
    return HASH_IDENTIFIER.test(value) ? value : '';
  }

  private static addScore(scores: Map<string, number>, identifier: string, score: number): void {
    if (!identifier || score <= 0) return;
    if ((scores.get(identifier) || 0) < score) scores.set(identifier, score);
  }

  private static imageObjectScore(object: any, aliasName: string, syncData: any): number {
    if (aliasName === 'GameTable') return 110;
    if (this.isOnTable(syncData)) return 95;
    if (aliasName === 'PeerCursor') return 90;
    if (aliasName === 'ChatTab') return 85;
    if (aliasName === 'GameCharacter' || aliasName === 'GameCharacterGroup') return 75;
    if (aliasName === 'data') return this.imageDataElementScore(object, syncData);
    if (aliasName === 'CutIn') return 30;
    return 20;
  }

  private static imagePathScore(object: any, aliasName: string, syncData: any, keyPath: string): number {
    if (keyPath.endsWith('backgroundImageIdentifier')) return 110;
    if (keyPath.endsWith('imageIdentifier')) return this.imageObjectScore(object, aliasName, syncData);
    if (syncData && (syncData.type === 'image' || syncData.attributes?.type === 'image')) return this.imageDataElementScore(object, syncData);
    return this.imageObjectScore(object, aliasName, syncData);
  }

  private static imageDataElementScore(object: any, syncData: any): number {
    if (!(syncData && (syncData.type === 'image' || syncData.attributes?.type === 'image'))) return 20;
    const rootInfo = this.rootInfo(object);
    if (rootInfo.aliasName === 'GameTable') return 110;
    if (rootInfo.isOnTable) return 95;
    if (rootInfo.aliasName === 'GameCharacter' || rootInfo.aliasName === 'GameCharacterGroup') return 75;
    return 35;
  }

  private static audioObjectScore(aliasName: string, syncData: any): number {
    if (aliasName === 'Jukebox' && syncData && syncData.isPlaying) return 110;
    return 15;
  }

  private static audioPathScore(aliasName: string, syncData: any, keyPath: string): number {
    if (!keyPath.endsWith('audioIdentifier')) return 0;
    if (aliasName === 'Jukebox' && syncData && syncData.isPlaying) return 110;
    if (keyPath.indexOf('jukeboxLayers') >= 0 || keyPath.indexOf('tableAudioLayers') >= 0) return 75;
    return 35;
  }

  private static isOnTable(syncData: any): boolean {
    return syncData && syncData.location && syncData.location.name === 'table';
  }

  private static rootInfo(object: any): { aliasName: string; isOnTable: boolean } {
    let current = object;
    let rootAlias = String(object?.aliasName || '');
    let onTable = false;
    for (let guard = 0; current && guard < 32; guard++) {
      const context = this.safeContext(current);
      const syncData = (context && context.syncData) || {};
      const aliasName = String((context && context.aliasName) || current?.aliasName || '');
      if (aliasName) rootAlias = aliasName;
      if (this.isOnTable(syncData)) onTable = true;
      current = current.parent;
    }
    return { aliasName: rootAlias, isOnTable: onTable };
  }

  private static walk(value: any, visitor: (value: any, path: string[]) => void, path: string[] = [], seen = new Set<any>()): void {
    visitor(value, path);
    if (!value || typeof value !== 'object') return;
    if (seen.has(value)) return;
    seen.add(value);

    if (Array.isArray(value)) {
      value.forEach((child, index) => this.walk(child, visitor, path.concat(String(index)), seen));
      return;
    }

    for (const key of Object.keys(value)) {
      this.walk(value[key], visitor, path.concat(key), seen);
    }
  }
}
