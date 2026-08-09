import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { Cookie, Request, Response } from "@paperback/types";

import { MdxAuthManager, type MadaraCookieStore } from "./auth.js";

const originalApplication = globalThis.Application;

const cookie = (name: string, value: string, lifetimeMs: number = 60_000): Cookie => ({
  name,
  value,
  domain: ".madaradex.org",
  path: "/",
  expires: new Date(Date.now() + lifetimeMs),
});

class MemoryStore implements MadaraCookieStore {
  cookies: Cookie[] = [];
  invalidations = 0;
  acceptances = 0;

  setCookie(value: Cookie): void {
    this.cookies = this.cookies.filter(
      (candidate) =>
        candidate.name !== value.name ||
        candidate.domain !== value.domain ||
        candidate.path !== value.path,
    );
    this.cookies.push(value);
  }

  deleteCookie(value: Cookie): void {
    this.cookies = this.cookies.filter(
      (candidate) =>
        candidate.name !== value.name ||
        candidate.domain !== value.domain ||
        candidate.path !== value.path,
    );
  }

  invalidateSensitiveCookies(): void {
    this.invalidations += 1;
    this.cookies = this.cookies.filter((candidate) => candidate.name !== "mdx_auth");
  }

  acceptSensitiveCookies(): void {
    this.acceptances += 1;
  }
}

let requests: Request[];
let nextAuth: Cookie | undefined;
let nextResponseUrl: string | undefined;
let nextResponseBody: ArrayBuffer;

beforeEach(() => {
  requests = [];
  nextAuth = cookie("mdx_auth", "auth-one", 6 * 60 * 60_000);
  nextResponseUrl = undefined;
  nextResponseBody = new ArrayBuffer(0);
  Object.assign(globalThis, {
    Application: {
      scheduleRequest: async (request: Request): Promise<[Response, ArrayBuffer]> => {
        requests.push(request);
        return [
          {
            url: nextResponseUrl ?? request.url,
            status: 200,
            headers: {},
            cookies: nextAuth ? [nextAuth] : [],
          },
          nextResponseBody,
        ];
      },
    },
  });
});

afterEach(() => Object.assign(globalThis, { Application: originalApplication }));

describe("MadaraDex ephemeral authentication", () => {
  it("creates a 16-byte fingerprint and obtains an auth token without user login", async () => {
    const store = new MemoryStore();
    const manager = new MdxAuthManager(store, {
      randomBytes: () => Uint8Array.from({ length: 16 }, (_, index) => index),
    });

    await manager.ensureAuthenticated();

    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.headers?.["x-mdx-auth-refresh"], "1");
    assert.equal(requests[0]?.cookies?.mdx_fp, "000102030405060708090a0b0c0d0e0f");
    assert.equal(store.cookies.find((value) => value.name === "mdx_fp")?.value.length, 32);
    assert.equal(store.cookies.find((value) => value.name === "mdx_auth")?.value, "auth-one");
    assert.equal(manager.isAuthenticated(), true);
  });

  it("coalesces concurrent refreshes and reuses a valid pair", async () => {
    const store = new MemoryStore();
    const manager = new MdxAuthManager(store, {
      randomBytes: () => new Uint8Array(16).fill(0xab),
    });
    await Promise.all(Array.from({ length: 20 }, () => manager.ensureAuthenticated()));
    await manager.ensureAuthenticated();
    assert.equal(requests.length, 1);
  });

  it("forces one token refresh after a CDN rejection without rotating a valid fingerprint", async () => {
    const store = new MemoryStore();
    store.cookies = [
      cookie("mdx_fp", "stable-fingerprint", 30 * 24 * 60 * 60_000),
      cookie("mdx_auth", "old"),
    ];
    const manager = new MdxAuthManager(store);
    nextAuth = cookie("mdx_auth", "new");

    await manager.refresh(true);

    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.cookies?.mdx_fp, "stable-fingerprint");
    assert.equal(
      store.cookies.find((value) => value.name === "mdx_fp")?.value,
      "stable-fingerprint",
    );
    assert.equal(store.cookies.find((value) => value.name === "mdx_auth")?.value, "new");
  });

  it("fails closed when the refresh endpoint does not issue mdx_auth", async () => {
    const store = new MemoryStore();
    const manager = new MdxAuthManager(store, { randomBytes: () => new Uint8Array(16) });
    nextAuth = undefined;
    await assert.rejects(manager.ensureAuthenticated(), /did not issue mdx_auth/i);
    assert.equal(manager.isAuthenticated(), false);
  });

  it("rejects auth cookies from a foreign final response URL", async () => {
    const store = new MemoryStore();
    const manager = new MdxAuthManager(store, { randomBytes: () => new Uint8Array(16) });
    nextResponseUrl = "https://evil.example/auth";

    await assert.rejects(manager.ensureAuthenticated(), /response URL was not trusted/i);
    assert.equal(
      store.cookies.some(({ name }) => name === "mdx_auth"),
      false,
    );
    assert.equal(manager.isAuthenticated(), false);
  });

  it("rejects oversized auth responses before accepting cookies", async () => {
    const store = new MemoryStore();
    const manager = new MdxAuthManager(store, { randomBytes: () => new Uint8Array(16) });
    nextResponseBody = new ArrayBuffer(256 * 1_024 + 1);

    await assert.rejects(manager.ensureAuthenticated(), /MadaraDex authentication.*too large/i);
    assert.equal(
      store.cookies.some(({ name }) => name === "mdx_auth"),
      false,
    );
    assert.equal(manager.isAuthenticated(), false);
  });

  it("times out refreshes, clears the in-flight slot, and blocks stale auth", async () => {
    const store = new MemoryStore();
    let resolvePending: ((value: [Response, ArrayBuffer]) => void) | undefined;
    Object.assign(globalThis, {
      Application: {
        scheduleRequest: async (request: Request): Promise<[Response, ArrayBuffer]> =>
          new Promise((resolve) => {
            requests.push(request);
            resolvePending = resolve;
          }),
      },
    });
    const manager = new MdxAuthManager(store, {
      randomBytes: () => new Uint8Array(16),
      refreshTimeoutMs: 5,
    });

    await assert.rejects(manager.ensureAuthenticated(), /refresh timed out/i);
    assert.equal(
      store.cookies.some((value) => value.name === "mdx_auth"),
      false,
    );
    assert.ok(store.invalidations >= 2);

    // A late completion from the timed-out request must not restore auth.
    resolvePending?.([
      {
        url: "https://madaradex.org/wp-admin/admin-ajax.php",
        status: 200,
        headers: {},
        cookies: [cookie("mdx_auth", "late")],
      },
      new ArrayBuffer(0),
    ]);
    assert.equal(manager.isAuthenticated(), false);

    Object.assign(globalThis, {
      Application: {
        scheduleRequest: async (request: Request): Promise<[Response, ArrayBuffer]> => [
          { url: request.url, status: 200, headers: {}, cookies: [cookie("mdx_auth", "fresh")] },
          new ArrayBuffer(0),
        ],
      },
    });
    await manager.ensureAuthenticated();
    assert.equal(manager.isAuthenticated(), true);
  });
});
