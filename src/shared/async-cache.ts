export interface AsyncKeyedCacheOptions {
  ttlMs: number;
  maxEntries: number;
  now?: () => number;
}

interface CacheEntry<V> {
  promise: Promise<V>;
  expiresAt: number;
  pending: boolean;
}

/** Small bounded LRU cache that also collapses identical in-flight requests. */
export class AsyncKeyedCache<K, V> {
  private readonly entries = new Map<K, CacheEntry<V>>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: AsyncKeyedCacheOptions) {
    if (!Number.isFinite(options.ttlMs) || options.ttlMs < 0) {
      throw new Error("AsyncKeyedCache ttlMs must be a non-negative finite number");
    }
    if (!Number.isInteger(options.maxEntries) || options.maxEntries < 1) {
      throw new Error("AsyncKeyedCache maxEntries must be a positive integer");
    }
    this.ttlMs = options.ttlMs;
    this.maxEntries = options.maxEntries;
    this.now = options.now ?? Date.now;
  }

  get(key: K, load: () => Promise<V>): Promise<V> {
    const existing = this.entries.get(key);
    if (existing && (existing.pending || existing.expiresAt > this.now())) {
      this.touch(key, existing);
      return existing.promise;
    }
    if (existing) this.entries.delete(key);

    const entry: CacheEntry<V> = {
      promise: Promise.resolve().then(load),
      expiresAt: Number.POSITIVE_INFINITY,
      pending: true,
    };
    this.entries.set(key, entry);
    this.evictOverflow(key);

    void entry.promise.then(
      () => {
        if (this.entries.get(key) !== entry) return;
        entry.pending = false;
        entry.expiresAt = this.now() + this.ttlMs;
        this.touch(key, entry);
      },
      () => {
        if (this.entries.get(key) === entry) this.entries.delete(key);
      },
    );
    return entry.promise;
  }

  delete(key: K): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  private touch(key: K, entry: CacheEntry<V>): void {
    this.entries.delete(key);
    this.entries.set(key, entry);
  }

  private evictOverflow(newestKey: K): void {
    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value as K | undefined;
      if (oldestKey === undefined) return;
      if (oldestKey === newestKey && this.entries.size > 1) {
        this.touch(oldestKey, this.entries.get(oldestKey) as CacheEntry<V>);
        continue;
      }
      this.entries.delete(oldestKey);
    }
  }
}
