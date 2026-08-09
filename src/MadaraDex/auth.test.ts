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
}

let requests: Request[];
let nextAuth: Cookie | undefined;

beforeEach(() => {
  requests = [];
  nextAuth = cookie("mdx_auth", "auth-one", 6 * 60 * 60_000);
  Object.assign(globalThis, {
    Application: {
      scheduleRequest: async (request: Request): Promise<[Response, ArrayBuffer]> => {
        requests.push(request);
        return [
          {
            url: request.url,
            status: 200,
            headers: {},
            cookies: nextAuth ? [nextAuth] : [],
          },
          new ArrayBuffer(0),
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
});
