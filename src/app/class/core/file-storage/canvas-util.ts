import { Logger } from '../system/util/logger';

export class CanvasUtil {
  /**
   * Canvas に高品質で画像を描画する。
   * imageSmoothingEnabled と imageSmoothingQuality を適切に設定する。
   */
  static drawImage(
    ctx: CanvasRenderingContext2D,
    image: CanvasImageSource,
    dx: number, dy: number, dw: number, dh: number
  ): void {
    ctx.imageSmoothingEnabled = true;
    (ctx as any).imageSmoothingQuality = 'high';
    ctx.drawImage(image, dx, dy, dw, dh);
  }

  /**
   * 多段階縮小で高品質なリサイズを行う。
   * 1回の縮小を最大50%までに制限し、段階的に縮小することでエイリアシング（ガビガビ）を防ぐ。
   *
   * 例: 2000px → 200px の場合、従来は1回で10%に縮小してジャギるが、
   *     多段階では 2000→1000→500→250→200 と4段階で縮小し、各段階で高品質スムージングが効く。
   *
   * @param source 元の画像データ
   * @param targetWidth 目標幅
   * @param targetHeight 目標高さ
   * @returns 縮小されたCanvas
   */
  static resizeCanvas(
    source: HTMLCanvasElement | HTMLImageElement,
    targetWidth: number,
    targetHeight: number
  ): HTMLCanvasElement {
    const sourceWidth = source instanceof HTMLImageElement ? source.naturalWidth : source.width;
    const sourceHeight = source instanceof HTMLImageElement ? source.naturalHeight : source.height;

    // 拡大の場合は1回で描画
    if (targetWidth >= sourceWidth || targetHeight >= sourceHeight) {
      const canvas = document.createElement('canvas');
      canvas.width = targetWidth;
      canvas.height = targetHeight;
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      (ctx as any).imageSmoothingQuality = 'high';
      ctx.drawImage(source, 0, 0, targetWidth, targetHeight);
      return canvas;
    }

    // 多段階縮小: 各ステップで最大50%まで縮小
    let currentWidth = sourceWidth;
    let currentHeight = sourceHeight;
    let currentCanvas: HTMLCanvasElement | HTMLImageElement = source;

    while (currentWidth > targetWidth * 2 || currentHeight > targetHeight * 2) {
      const nextWidth = Math.max(targetWidth, Math.round(currentWidth / 2));
      const nextHeight = Math.max(targetHeight, Math.round(currentHeight / 2));

      const stepCanvas = document.createElement('canvas');
      stepCanvas.width = nextWidth;
      stepCanvas.height = nextHeight;
      const ctx = stepCanvas.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      (ctx as any).imageSmoothingQuality = 'high';
      ctx.drawImage(currentCanvas, 0, 0, nextWidth, nextHeight);

      currentCanvas = stepCanvas;
      currentWidth = nextWidth;
      currentHeight = nextHeight;
    }

    // 最終ステップ: 目標サイズへ
    const finalCanvas = document.createElement('canvas');
    finalCanvas.width = targetWidth;
    finalCanvas.height = targetHeight;
    const finalCtx = finalCanvas.getContext('2d');
    finalCtx.imageSmoothingEnabled = true;
    (finalCtx as any).imageSmoothingQuality = 'high';
    finalCtx.drawImage(currentCanvas, 0, 0, targetWidth, targetHeight);

    return finalCanvas;
  }

  /**
   * 画像Blobを指定サイズに多段階縮小してBlobとして出力する。
   * サムネイル生成やアップロード圧縮で使用。
   *
   * @param blob 元画像のBlob
   * @param maxDim 最大辺サイズ（px）
   * @param quality JPEG/WebP圧縮品質（0-1）
   * @param mimeType 出力MIME类型（'image/jpeg' | 'image/png' | 'image/webp'）
   */
  static async resizeBlob(
    blob: Blob,
    targetWidth: number,
    targetHeight: number,
    quality: number = 0.85,
    mimeType?: string
  ): Promise<Blob | null> {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        try {
          const canvas = CanvasUtil.resizeCanvas(img, targetWidth, targetHeight);
          const type = mimeType || blob.type || 'image/jpeg';
          const isPng = type === 'image/png';
          canvas.toBlob(
            (resultBlob) => {
              URL.revokeObjectURL(url);
              resolve(resultBlob);
            },
            type,
            isPng ? undefined : quality
          );
        } catch (e) {
          Logger.warn('CanvasUtil.resizeBlob failed', e);
          URL.revokeObjectURL(url);
          resolve(null);
        }
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        resolve(null);
      };
      img.src = url;
    });
  }

  /**
   * 既存の画像URLを、表示サイズに合わせた高品質縮小済み object URL に変換する。
   * コマ表示など「元画像は大きいが画面上では小さい」用途向け。
   */
  static async resizeImageUrl(
    sourceUrl: string,
    targetWidth: number,
    targetHeight: number,
    quality: number = 0.9,
    mimeType: string = 'image/png'
  ): Promise<string | null> {
    return new Promise((resolve) => {
      if (!sourceUrl || targetWidth <= 0 || targetHeight <= 0) {
        resolve(null);
        return;
      }

      const image = new Image();
      image.onload = () => {
        try {
          const canvas = CanvasUtil.resizeCanvas(image, Math.round(targetWidth), Math.round(targetHeight));
          canvas.toBlob(blob => {
            if (!blob) {
              resolve(null);
              return;
            }
            resolve(URL.createObjectURL(blob));
          }, mimeType, mimeType === 'image/png' ? undefined : quality);
        } catch (e) {
          Logger.warn('CanvasUtil.resizeImageUrl failed', e);
          resolve(null);
        }
      };
      image.onerror = () => resolve(null);
      image.src = sourceUrl;
    });
  }

}
