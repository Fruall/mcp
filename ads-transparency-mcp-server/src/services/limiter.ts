/**
 * Concurrency limiter with a minimum spacing between task starts.
 * Keeps traffic to Google's internal endpoint polite and predictable.
 */
export class Limiter {
  private active = 0;
  private lastStart = -Infinity;
  private readonly queue: Array<() => void> = [];

  constructor(
    private readonly concurrency: number,
    private readonly minIntervalMs: number,
  ) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    return new Promise((resolve) => {
      this.queue.push(resolve);
      this.pump();
    });
  }

  private release(): void {
    this.active--;
    this.pump();
  }

  private timer: ReturnType<typeof setTimeout> | null = null;

  private pump(): void {
    if (this.timer || this.active >= this.concurrency || this.queue.length === 0) return;
    const wait = this.lastStart + this.minIntervalMs - performance.now();
    if (wait > 0) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.pump();
      }, wait);
      return;
    }
    const next = this.queue.shift();
    if (!next) return;
    this.active++;
    this.lastStart = performance.now();
    next();
    this.pump();
  }
}

/** Runs `fn` over `items` with at most `concurrency` in flight, preserving order. */
export async function mapLimit<T, R>(items: T[], concurrency: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index] as T, index);
    }
  });
  await Promise.all(workers);
  return results;
}
