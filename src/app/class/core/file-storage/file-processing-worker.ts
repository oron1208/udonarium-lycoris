import { Logger } from '../system/util/logger';
import { AsyncWorkQueue } from '../system/util/async-work-queue';

type TaskType = 'sha256' | 'compressImage' | 'createThumbnail';

type PendingTask = {
  resolve: (value: any) => void;
  reject: (reason?: any) => void;
  timer: any;
};

export namespace FileProcessingWorker {
  let worker: Worker | null | undefined;
  let workerFailed = false; // Worker生成失敗フラグ（1回検出したら以降は試さない）
  let nextId = 1;
  const pending = new Map<number, PendingTask>();
  const workQueue = new AsyncWorkQueue(2);

  function failWorker(reason: any) {
    workerFailed = true;
    worker?.terminate();
    worker = null;
    for (const task of pending.values()) { clearTimeout(task.timer); task.reject(reason); }
    pending.clear();
  }

  export function isAvailable(): boolean {
    return !workerFailed && !!getWorker();
  }

  export async function sha256(data: Blob | ArrayBuffer): Promise<string> {
    return request<string>('sha256', { data });
  }

  export async function compressImage(blob: Blob, maxDim = 1920, quality = 0.85): Promise<{ blob: Blob; type: string; width: number; height: number }> {
    return request('compressImage', { blob, maxDim, quality });
  }

  export async function createThumbnail(blob: Blob, maxDim = 128): Promise<{ blob: Blob; type: string; width: number; height: number }> {
    return request('createThumbnail', { blob, maxDim });
  }

  function getWorker(): Worker | null {
    if (workerFailed) return null;
    if (worker !== undefined) return worker;
    if (typeof Worker === 'undefined') {
      workerFailed = true;
      worker = null;
      return worker;
    }
    try {
      worker = new Worker(new URL('./file-processing.worker', import.meta.url), { type: 'module' });
      worker.onmessage = ({ data }) => {
        const task = pending.get(data?.id);
        if (!task) return;
        pending.delete(data.id);
        clearTimeout(task.timer);
        if (data.ok) task.resolve(data.result);
        else task.reject(new Error(data.error || 'Worker task failed'));
      };
      worker.onerror = error => {
        Logger.warn('[FileProcessingWorker] worker error', error);
        failWorker(new Error('File processing worker failed'));
      };
      worker.onmessageerror = () => failWorker(new Error('File processing worker message failed'));
    } catch (error) {
      // Angular 13等、Workerバンドル未対応環境では1回だけ警告して以降は黙ってフォールバック
      Logger.info('[FileProcessingWorker] Worker unavailable, using main-thread fallback', error);
      workerFailed = true;
      worker = null;
    }
    return worker;
  }

  function request<T>(type: TaskType, payload: any, timeoutMs = 60_000): Promise<T> {
    return workQueue.run(() => requestNow<T>(type, payload, timeoutMs));
  }

  function requestNow<T>(type: TaskType, payload: any, timeoutMs: number): Promise<T> {
    const w = getWorker();
    if (!w) return Promise.reject(new Error('Worker is unavailable'));

    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        failWorker(new Error(`Worker task timeout: ${type}`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try {
        w.postMessage({ id, type, payload });
      } catch (error) {
        pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }
}
