/// <reference lib="webworker" />

/**
 * 重いファイル処理をメインスレッドから逃がすWorker。
 * - SHA-256: WebCrypto
 * - 画像圧縮/サムネイル: createImageBitmap + OffscreenCanvas
 */

type WorkerRequest = {
  id: number;
  type: 'sha256' | 'compressImage' | 'createThumbnail';
  payload: any;
};

addEventListener('message', async ({ data }: MessageEvent<WorkerRequest>) => {
  const { id, type, payload } = data;
  try {
    let result: any;
    switch (type) {
      case 'sha256':
        result = await sha256Hex(payload.data);
        break;
      case 'compressImage':
        result = await resizeImage(payload.blob, payload.maxDim || 1920, payload.quality ?? 0.85, true);
        break;
      case 'createThumbnail':
        result = await resizeImage(payload.blob, payload.maxDim || 128, payload.quality ?? 0.9, false, true);
        break;
      default:
        throw new Error(`Unknown worker task: ${type}`);
    }
    postMessage({ id, ok: true, result });
  } catch (error) {
    postMessage({
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

async function sha256Hex(data: Blob | ArrayBuffer): Promise<string> {
  const arrayBuffer = data instanceof Blob ? await data.arrayBuffer() : data;
  const hashBuffer = await crypto.subtle.digest('SHA-256', arrayBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

async function resizeImage(
  blob: Blob,
  maxDim: number,
  quality: number,
  preservePng: boolean,
  forceResize = false,
): Promise<{ blob: Blob; type: string; width: number; height: number }> {
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas === 'undefined') {
    throw new Error('OffscreenCanvas/createImageBitmap is not supported');
  }

  const bitmap = await createImageBitmap(blob);
  try {
    let { width, height } = bitmap;
    let needResize = forceResize || width > maxDim || height > maxDim;
    if (needResize) {
      const ratio = Math.min(maxDim / width, maxDim / height, 1);
      width = Math.max(1, Math.round(width * ratio));
      height = Math.max(1, Math.round(height * ratio));
    }

    const canvas = needResize
      ? multiStepDownscale(bitmap, width, height)
      : (() => {
          const c = new OffscreenCanvas(width, height);
          const ctx = c.getContext('2d');
          if (!ctx) throw new Error('2D canvas context is not available');
          ctx.drawImage(bitmap, 0, 0);
          return c;
        })();

    const inputType = blob.type || 'image/png';
    const isPng = inputType === 'image/png';
    const type = preservePng && isPng ? 'image/png' : 'image/jpeg';
    const out = await canvas.convertToBlob({ type, quality: isPng ? undefined : quality });
    return { blob: out, type: out.type || type, width, height };
  } finally {
    if (typeof bitmap.close === 'function') bitmap.close();
  }
}

/**
 * 多段階縮小で高品質なリサイズを行う（Worker / OffscreenCanvas版）。
 * 1回の縮小を最大50%までに制限し、段階的に縮小することでエイリアシングを防ぐ。
 */
function multiStepDownscale(
  source: ImageBitmap | OffscreenCanvas,
  targetWidth: number,
  targetHeight: number
): OffscreenCanvas {
  const sourceWidth = source.width;
  const sourceHeight = source.height;

  // 拡大または同サイズの場合は1回で描画
  if (targetWidth >= sourceWidth || targetHeight >= sourceHeight) {
    const canvas = new OffscreenCanvas(targetWidth, targetHeight);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas context is not available');
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(source, 0, 0, targetWidth, targetHeight);
    return canvas;
  }

  // 多段階縮小: 各ステップで最大50%まで縮小
  let currentWidth = sourceWidth;
  let currentHeight = sourceHeight;
  let currentSource: ImageBitmap | OffscreenCanvas = source;

  while (currentWidth > targetWidth * 2 || currentHeight > targetHeight * 2) {
    const nextWidth = Math.max(targetWidth, Math.round(currentWidth / 2));
    const nextHeight = Math.max(targetHeight, Math.round(currentHeight / 2));

    const stepCanvas = new OffscreenCanvas(nextWidth, nextHeight);
    const ctx = stepCanvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas context is not available');
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(currentSource, 0, 0, nextWidth, nextHeight);

    currentSource = stepCanvas;
    currentWidth = nextWidth;
    currentHeight = nextHeight;
  }

  // 最終ステップ: 目標サイズへ
  const finalCanvas = new OffscreenCanvas(targetWidth, targetHeight);
  const finalCtx = finalCanvas.getContext('2d');
  if (!finalCtx) throw new Error('2D canvas context is not available');
  finalCtx.imageSmoothingEnabled = true;
  finalCtx.drawImage(currentSource, 0, 0, targetWidth, targetHeight);

  return finalCanvas;
}
