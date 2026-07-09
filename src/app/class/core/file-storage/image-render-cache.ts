import { CanvasUtil } from './canvas-util';

interface CacheEntry {
  sourceUrl: string;
  renderUrl: string;
  width: number;
  height: number;
  lastUsed: number;
}

/**
 * コマ表示用の高品質縮小キャッシュ。
 * 大きい立ち絵をブラウザ任せで極小表示するとジャギ/モアレが出るため、
 * 表示サイズに近い解像度へ多段階縮小してから <img> に渡す。
 */
export class ImageRenderCache {
  private static readonly MAX_ENTRIES = 96;
  private static readonly MAX_DPR = 2;
  private static cache: Map<string, CacheEntry> = new Map();

  static async get(sourceUrl: string, cssWidth: number, cssHeight: number): Promise<string | null> {
    if (!sourceUrl || cssWidth <= 0 || cssHeight <= 0) return null;

    const dpr = Math.min(Math.max(window.devicePixelRatio || 1, 1), this.MAX_DPR);
    const width = Math.max(1, Math.round(cssWidth * dpr));
    const height = Math.max(1, Math.round(cssHeight * dpr));
    const key = `${sourceUrl}|${width}x${height}`;
    const cached = this.cache.get(key);
    if (cached) {
      cached.lastUsed = performance.now();
      return cached.renderUrl;
    }

    const renderUrl = await CanvasUtil.resizeImageUrl(sourceUrl, width, height, 0.9, 'image/png');
    if (!renderUrl) return null;

    this.cache.set(key, {
      sourceUrl,
      renderUrl,
      width,
      height,
      lastUsed: performance.now()
    });
    this.sweep();
    return renderUrl;
  }

  static shouldDownscale(naturalWidth: number, naturalHeight: number, cssWidth: number, cssHeight: number): boolean {
    if (naturalWidth <= 0 || naturalHeight <= 0 || cssWidth <= 0 || cssHeight <= 0) return false;
    const dpr = Math.min(Math.max(window.devicePixelRatio || 1, 1), this.MAX_DPR);
    return naturalWidth > cssWidth * dpr * 1.25 || naturalHeight > cssHeight * dpr * 1.25;
  }

  static releaseSource(sourceUrl: string): void {
    if (!sourceUrl) return;
    for (const [key, entry] of Array.from(this.cache.entries())) {
      if (entry.sourceUrl !== sourceUrl) continue;
      URL.revokeObjectURL(entry.renderUrl);
      this.cache.delete(key);
    }
  }

  private static sweep(): void {
    if (this.cache.size <= this.MAX_ENTRIES) return;
    const entries = Array.from(this.cache.entries()).sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    while (this.cache.size > this.MAX_ENTRIES && entries.length > 0) {
      const [key, entry] = entries.shift();
      URL.revokeObjectURL(entry.renderUrl);
      this.cache.delete(key);
    }
  }
}
