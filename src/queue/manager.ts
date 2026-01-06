import PQueue from 'p-queue';

export class RequestQueue {
  private queue: PQueue;

  constructor(concurrency: number = 1) {
    // Set concurrency to 1 to ensure messages are processed serially
    this.queue = new PQueue({ concurrency });
  }

  async add<T>(fn: () => Promise<T>): Promise<T> {
    return this.queue.add(fn);
  }

  getSize(): number {
    return this.queue.size;
  }

  getPending(): number {
    return this.queue.pending;
  }

  async waitForIdle(): Promise<void> {
    await this.queue.onIdle();
  }
}
