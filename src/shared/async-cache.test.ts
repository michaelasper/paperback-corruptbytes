import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AsyncKeyedCache, utf8ByteLength } from "./async-cache.js";

describe("AsyncKeyedCache", () => {
  it("counts UTF-8 bytes exactly, including malformed UTF-16", () => {
    const cases: ReadonlyArray<readonly [string, number]> = [
      ["", 0],
      ["ASCII 123", 9],
      ["é", 2],
      ["€", 3],
      ["中", 3],
      ["😀", 4],
      ["aé€😀", 10],
      ["\u0009\u000a\u000d", 3],
      ["\ud800", 3],
      ["\udfff", 3],
      ["\ud800\udfff", 4],
      ["a\ud800b\udfffc", 9],
    ];

    for (const [value, expected] of cases) {
      assert.equal(utf8ByteLength(value), expected, JSON.stringify(value));
      assert.equal(new TextEncoder().encode(value).byteLength, expected, JSON.stringify(value));
    }
  });

  it("does not require a global TextEncoder", () => {
    const value = "ASCIIé€😀\ud800\udfff";
    const expected = new TextEncoder().encode(value).byteLength;
    const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, "TextEncoder");
    Object.defineProperty(globalThis, "TextEncoder", {
      configurable: true,
      value: undefined,
    });
    try {
      assert.equal(utf8ByteLength(value), expected);
    } finally {
      if (originalDescriptor) Object.defineProperty(globalThis, "TextEncoder", originalDescriptor);
      else Reflect.deleteProperty(globalThis, "TextEncoder");
    }
  });

  it("counts long mixed strings without changing exact byte totals", () => {
    const value = `${"plain-".repeat(4_000)}${"é€中😀".repeat(4_000)}\ud800${"-tail".repeat(4_000)}`;
    assert.equal(utf8ByteLength(value), new TextEncoder().encode(value).byteLength);
  });

  it("evicts least-recently-used resolved entries under a weight budget", async () => {
    let calls = 0;
    const cache = new AsyncKeyedCache<string, string>({
      ttlMs: 1_000,
      maxEntries: 4,
      maxWeight: 5,
      weigh: (value) => value.length,
    });
    const load = async (key: string, value: string) => {
      calls += 1;
      void key;
      return value;
    };

    assert.equal(await cache.get("a", () => load("a", "aa")), "aa");
    assert.equal(await cache.get("b", () => load("b", "bbb")), "bbb");
    assert.equal(await cache.get("a", () => load("a", "changed")), "aa");
    assert.equal(await cache.get("c", () => load("c", "cc")), "cc");

    // `b` is the least recently used entry and is the only one evicted to
    // bring the aggregate weight back under five.
    assert.equal(await cache.get("a", () => load("a", "changed")), "aa");
    assert.equal(await cache.get("b", () => load("b", "bbb")), "bbb");
    assert.equal(calls, 4);
  });

  it("returns oversized values to the caller without retaining them", async () => {
    let calls = 0;
    const cache = new AsyncKeyedCache<string, string>({
      ttlMs: 1_000,
      maxEntries: 2,
      maxWeight: 4,
      weigh: (value) => value.length,
    });

    assert.equal(
      await cache.get("large", async () => {
        calls += 1;
        return "too-large";
      }),
      "too-large",
    );
    assert.equal(
      await cache.get("large", async () => {
        calls += 1;
        return "too-large-again";
      }),
      "too-large-again",
    );
    assert.equal(calls, 2);
  });

  it("does not evict a replacement when an older mapped result fails", async () => {
    const cache = new AsyncKeyedCache<string, string>({
      ttlMs: 1_000,
      maxEntries: 1,
    });
    let mappingStarted = false;
    let releaseMapping!: () => void;
    const mappingGate = new Promise<void>((resolve) => {
      releaseMapping = resolve;
    });
    const mapped = cache.getMapped(
      "key",
      async () => "stale",
      async () => {
        mappingStarted = true;
        await mappingGate;
        throw new Error("stale shape");
      },
    );
    while (!mappingStarted) await Promise.resolve();

    cache.delete("key");
    assert.equal(await cache.get("key", async () => "replacement"), "replacement");
    releaseMapping();
    await assert.rejects(mapped, /stale shape/);
    assert.equal(await cache.get("key", async () => "unexpected"), "replacement");
  });

  it("validates weighted cache options", async () => {
    assert.throws(
      () => new AsyncKeyedCache<string, string>({ ttlMs: 1_000, maxEntries: 1, maxWeight: -1 }),
      /maxWeight must be a non-negative finite number/,
    );
    assert.throws(
      () => new AsyncKeyedCache<string, string>({ ttlMs: 1_000, maxEntries: 1, maxWeight: 1 }),
      /value weigher is required when maxWeight is configured/,
    );
    assert.throws(
      () =>
        new AsyncKeyedCache<string, string>({
          ttlMs: 1_000,
          maxEntries: 1,
          maxWeight: 1,
          maxBytes: 2,
          weigh: (value) => value.length,
        }),
      /maxWeight and maxBytes must match/,
    );
    const bytesCache = new AsyncKeyedCache<string, string>({
      ttlMs: 1_000,
      maxEntries: 1,
      maxBytes: 2,
      weigh: (value) => value.length,
    });
    assert.equal(await bytesCache.get("key", async () => "ok"), "ok");
    const cache = new AsyncKeyedCache<string, string>({
      ttlMs: 1_000,
      maxEntries: 1,
      maxWeight: 1,
      weigh: () => Number.NaN,
    });
    assert.equal(await cache.get("key", async () => "value"), "value");
    assert.equal(await cache.get("key", async () => "corrected"), "corrected");
  });

  it("coalesces concurrent loads and reuses a fresh value", async () => {
    let calls = 0;
    const cache = new AsyncKeyedCache<string, string>({ ttlMs: 1_000, maxEntries: 4 });
    const load = async () => {
      calls += 1;
      await Promise.resolve();
      return "page";
    };

    const [first, second] = await Promise.all([cache.get("home", load), cache.get("home", load)]);

    assert.equal(first, "page");
    assert.equal(second, "page");
    assert.equal(await cache.get("home", load), "page");
    assert.equal(calls, 1);
  });

  it("refreshes expired entries using an injectable monotonic clock", async () => {
    let now = 100;
    let calls = 0;
    const cache = new AsyncKeyedCache<string, number>({
      ttlMs: 50,
      maxEntries: 2,
      now: () => now,
    });

    assert.equal(await cache.get("key", async () => ++calls), 1);
    now = 149;
    assert.equal(await cache.get("key", async () => ++calls), 1);
    now = 150;
    assert.equal(await cache.get("key", async () => ++calls), 2);
  });

  it("does not surface bookkeeping failures from an injected clock", async () => {
    let clockCalls = 0;
    let loads = 0;
    const cache = new AsyncKeyedCache<string, string>({
      ttlMs: 50,
      maxEntries: 1,
      now: () => {
        clockCalls += 1;
        if (clockCalls === 1) throw new Error("clock failed during settlement");
        return clockCalls;
      },
    });

    assert.equal(await cache.get("key", async () => `value-${++loads}`), "value-1");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(await cache.get("key", async () => `value-${++loads}`), "value-2");
  });

  it("never caches failures and supports explicit invalidation", async () => {
    const cache = new AsyncKeyedCache<string, string>({ ttlMs: 1_000, maxEntries: 2 });
    let calls = 0;

    await assert.rejects(
      cache.get("key", async () => {
        calls += 1;
        throw new Error("offline");
      }),
      /offline/,
    );
    assert.equal(await cache.get("key", async () => `value-${++calls}`), "value-2");
    cache.delete("key");
    assert.equal(await cache.get("key", async () => `value-${++calls}`), "value-3");
  });

  it("evicts least-recently-used entries at the configured bound", async () => {
    const cache = new AsyncKeyedCache<string, string>({ ttlMs: 1_000, maxEntries: 2 });
    let calls = 0;
    const load = async (key: string) => `${key}-${++calls}`;

    assert.equal(await cache.get("a", () => load("a")), "a-1");
    assert.equal(await cache.get("b", () => load("b")), "b-2");
    assert.equal(await cache.get("a", () => load("a")), "a-1");
    assert.equal(await cache.get("c", () => load("c")), "c-3");
    assert.equal(await cache.get("b", () => load("b")), "b-4");
  });
});
