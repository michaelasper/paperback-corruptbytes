import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AsyncKeyedCache } from "./async-cache.js";

describe("AsyncKeyedCache", () => {
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
