/** Bounded, priority-ordered work. Waiting time is not part of a task's I/O timeout. */
export class AsyncWorkQueue {
  private running = 0;
  private waiting: { priority: number; order: number; start: () => void }[] = [];
  private nextOrder = 0;
  private scheduled = false;

  constructor(readonly concurrency: number) {
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('Invalid concurrency');
  }

  get active(): number { return this.running; }
  get pending(): number { return this.waiting.length; }

  run<T>(work: () => Promise<T>, priority = 0): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.waiting.push({ priority, order: this.nextOrder++, start: () => {
        this.running++;
        Promise.resolve().then(work).then(value => {
          this.running--; resolve(value); this.drain();
        }, error => {
          this.running--; reject(error); this.drain();
        });
      } });
      this.drain();
    });
  }

  private drain() {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.waiting.sort((a, b) => b.priority - a.priority || a.order - b.order);
      while (this.running < this.concurrency && this.waiting.length) this.waiting.shift().start();
    });
  }
}
