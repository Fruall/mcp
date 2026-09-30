/** Small in-memory LRU cache with per-entry TTL. Concurrent loads of the same key share one promise. */
export class TtlCache {
  private readonly entries = new Map<string, { expires: number; value: unknown }>();
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(private readonly maxEntries = 2_000) {}

  get<T>(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expires < Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    // Refresh recency.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value as T;
  }

  set(key: string, value: unknown, ttlMs: number): void {
    this.entries.delete(key);
    this.entries.set(key, { value, expires: Date.now() + ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  async getOrLoad<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const hit = this.get<T>(key);
    if (hit !== undefined) return hit;
    const pending = this.inflight.get(key);
    if (pending) return pending as Promise<T>;
    const promise = load()
      .then((value) => {
        this.set(key, value, ttlMs);
        return value;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    return promise;
  }

  get size(): number {
    return this.entries.size;
  }
}
