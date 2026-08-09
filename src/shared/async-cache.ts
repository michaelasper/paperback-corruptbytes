export type AsyncKeyedCacheValueWeigher<V> = (value: V) => number;

export interface AsyncKeyedCacheOptions<V = unknown> {
  ttlMs: number;
  maxEntries: number;
  now?: () => number;
  /** Optional aggregate weight budget for resolved values. */
  maxWeight?: number;
  /** Alias for maxWeight when the value weigher reports bytes. */
  maxBytes?: number;
  /** Deterministic, non-negative weight for each resolved value. */
  weigh?: AsyncKeyedCacheValueWeigher<V>;
}

interface CacheEntry<V> {
  promise: Promise<V>;
  expiresAt: number;
  pending: boolean;
  weight?: number;
}

/** Return the UTF-8 byte length of a string without allocating or requiring TextEncoder. */
export const utf8ByteLength = (value: string): number => {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x7f) {
      bytes += 1;
      continue;
    }
    if (codeUnit <= 0x7ff) {
      bytes += 2;
      continue;
    }
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
      continue;
    }
    // Lone low surrogates, like lone high surrogates, encode as U+FFFD.
    bytes += 3;
  }
  return bytes;
};

/** Small bounded LRU cache that also collapses identical in-flight requests. */
export class AsyncKeyedCache<K, V> {
  private readonly entries = new Map<K, CacheEntry<V>>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly maxWeight: number | undefined;
  private readonly weigh: AsyncKeyedCacheValueWeigher<V> | undefined;
  private readonly now: () => number;
  private totalWeight = 0;

  constructor(options: AsyncKeyedCacheOptions<V>) {
    if (
      options.maxWeight !== undefined &&
      options.maxBytes !== undefined &&
      options.maxWeight !== options.maxBytes
    ) {
      throw new Error("AsyncKeyedCache maxWeight and maxBytes must match when both are provided");
    }
    const configuredWeight = options.maxWeight !== undefined ? options.maxWeight : options.maxBytes;
    if (!Number.isFinite(options.ttlMs) || options.ttlMs < 0) {
      throw new Error("AsyncKeyedCache ttlMs must be a non-negative finite number");
    }
    if (!Number.isInteger(options.maxEntries) || options.maxEntries < 1) {
      throw new Error("AsyncKeyedCache maxEntries must be a positive integer");
    }
    if (
      configuredWeight !== undefined &&
      (!Number.isFinite(configuredWeight) || configuredWeight < 0)
    ) {
      throw new Error("AsyncKeyedCache maxWeight must be a non-negative finite number");
    }
    if (options.weigh !== undefined && typeof options.weigh !== "function") {
      throw new Error("AsyncKeyedCache value weigher must be a function");
    }
    if (configuredWeight !== undefined && options.weigh === undefined) {
      throw new Error("AsyncKeyedCache value weigher is required when maxWeight is configured");
    }
    if (configuredWeight === undefined && options.weigh !== undefined) {
      throw new Error("AsyncKeyedCache maxWeight is required when a value weigher is configured");
    }
    this.ttlMs = options.ttlMs;
    this.maxEntries = options.maxEntries;
    this.maxWeight = configuredWeight;
    this.weigh = options.weigh;
    this.now = options.now ?? Date.now;
  }

  get(key: K, load: () => Promise<V>): Promise<V> {
    const existing = this.entries.get(key);
    if (existing && (existing.pending || existing.expiresAt > this.now())) {
      this.touch(key, existing);
      return existing.promise;
    }
    if (existing) this.removeEntry(key);

    const entry: CacheEntry<V> = {
      promise: Promise.resolve().then(load),
      expiresAt: Number.POSITIVE_INFINITY,
      pending: true,
    };
    this.entries.set(key, entry);
    this.evictOverflow(key);

    // Keep the bookkeeping branch fully handled. In particular, a stale
    // promise that was evicted before settling must not mutate a replacement
    // entry or create an unhandled rejection in the cache itself.
    void entry.promise.then(
      (value) => {
        try {
          this.settle(key, entry, value);
        } catch {
          this.removeIfCurrent(key, entry);
        }
      },
      () => this.removeIfCurrent(key, entry),
    );
    return entry.promise;
  }

  /** Load a raw value and map it while evicting parser failures safely. */
  getMapped<T>(key: K, load: () => Promise<V>, map: (value: V) => T | PromiseLike<T>): Promise<T> {
    const promise = this.get(key, load);
    return promise.then(async (value) => {
      try {
        return await map(value);
      } catch (error: unknown) {
        // Only evict the raw value observed by this mapper. A replacement
        // request may have installed a newer entry while mapping was pending.
        this.removeIfCurrentPromise(key, promise);
        throw error;
      }
    });
  }

  delete(key: K): void {
    this.removeEntry(key);
  }

  clear(): void {
    this.entries.clear();
    this.totalWeight = 0;
  }

  private settle(key: K, entry: CacheEntry<V>, value: V): void {
    if (this.entries.get(key) !== entry) return;

    let weight: number | undefined;
    if (this.weigh) {
      try {
        weight = this.weigh(value);
      } catch {
        // A malformed weigher must never turn a successful load into an
        // unhandled bookkeeping rejection. The value remains available to the
        // initiating caller but is not retained.
        this.removeIfCurrent(key, entry);
        return;
      }
      if (!Number.isFinite(weight) || weight < 0) {
        this.removeIfCurrent(key, entry);
        return;
      }
    }

    entry.pending = false;
    entry.expiresAt = this.now() + this.ttlMs;
    entry.weight = weight;
    if (weight !== undefined) this.totalWeight += weight;
    this.touch(key, entry);
    this.evictOverflow(key);
  }

  private touch(key: K, entry: CacheEntry<V>): void {
    this.entries.delete(key);
    this.entries.set(key, entry);
  }

  private evictOverflow(newestKey: K): void {
    while (
      this.entries.size > this.maxEntries ||
      (this.maxWeight !== undefined && this.totalWeight > this.maxWeight)
    ) {
      const oldestKey = this.entries.keys().next().value as K | undefined;
      if (oldestKey === undefined) return;
      if (oldestKey === newestKey && this.entries.size > 1) {
        this.touch(oldestKey, this.entries.get(oldestKey) as CacheEntry<V>);
        continue;
      }
      this.removeEntry(oldestKey);
    }
  }

  private removeIfCurrent(key: K, entry: CacheEntry<V>): void {
    if (this.entries.get(key) === entry) this.removeEntry(key);
  }

  private removeIfCurrentPromise(key: K, promise: Promise<V>): void {
    const entry = this.entries.get(key);
    if (entry?.promise === promise) this.removeEntry(key);
  }

  private removeEntry(key: K): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    if (entry.weight !== undefined) {
      this.totalWeight = Math.max(0, this.totalWeight - entry.weight);
    }
  }
}
