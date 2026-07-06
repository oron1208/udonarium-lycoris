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
    if (forceResize || width > maxDim || height > maxDim) {
      const ratio = Math.min(maxDim / width, maxDim / height, 1);
      width = Math.max(1, Math.round(width * ratio));
      height = Math.max(1, Math.round(height * ratio));
    }

    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas context is not available');
    ctx.drawImage(bitmap, 0, 0, width, height);

    const inputType = blob.type || 'image/png';
    const isPng = inputType === 'image/png';
    const type = preservePng && isPng ? 'image/png' : 'image/jpeg';
    const out = await canvas.convertToBlob({ type, quality: isPng ? undefined : quality });
    return { blob: out, type: out.type || type, width, height };
  } finally {
    if (typeof bitmap.close === 'function') bitmap.close();
  }
}
