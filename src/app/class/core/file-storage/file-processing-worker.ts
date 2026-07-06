import { Logger } from '../system/util/logger';

type TaskType = 'sha256' | 'compressImage' | 'createThumbnail';

type PendingTask = {
  resolve: (value: any) => void;
  reject: (reason?: any) => void;
  timer: any;
};

export namespace FileProcessingWorker {
  let worker: Worker | null | undefined;
  let nextId = 1;
  const pending = new Map<number, PendingTask>();

  export function isAvailable(): boolean {
    return !!getWorker();
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
    if (worker !== undefined) return worker;
    if (typeof Worker === 'undefined') {
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
      };
    } catch (error) {
      Logger.warn('[FileProcessingWorker] unavailable', error);
      worker = null;
    }
    return worker;
  }

  function request<T>(type: TaskType, payload: any, timeoutMs = 60_000): Promise<T> {
    const w = getWorker();
    if (!w) return Promise.reject(new Error('Worker is unavailable'));

    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Worker task timeout: ${type}`));
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
