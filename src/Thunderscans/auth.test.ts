import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import type { Cookie, Request, Response } from "@paperback/types";

import {
  clearThunderSession,
  fetchAccountStatus,
  isThunderCookie,
  persistThunderCookies,
  replaceThunderCookies,
  type ThunderCookieStore,
} from "./auth.js";

const originalApplication = globalThis.Application;

const cookie = (overrides: Partial<Cookie> = {}): Cookie => ({
  name: "PHPSESSID",
  value: "session",
  domain: "en-thunderscans.com",
  path: "/",
  ...overrides,
});

class MemoryStore implements ThunderCookieStore {
  cookies: Cookie[] = [];
  invalidations = 0;
  acceptances = 0;

  setCookie(value: Cookie): void {
    this.cookies = this.cookies.filter(
      (candidate) => candidate.name !== value.name || candidate.domain !== value.domain,
    );
    this.cookies.push(value);
  }

  deleteCookie(value: Cookie): void {
    this.cookies = this.cookies.filter(
      (candidate) => candidate.name !== value.name || candidate.domain !== value.domain,
    );
  }

  invalidateAuthCookies(): void {
    this.invalidations += 1;
  }

  acceptAuthCookies(): void {
    this.acceptances += 1;
  }
}

afterEach(() => {
  Object.assign(globalThis, { Application: originalApplication });
});

describe("Thunder authentication", () => {
  it("accepts only source cookies and preserves Cloudflare when clearing a session", () => {
    const store = new MemoryStore();
    const clearance = cookie({ name: "cf_clearance", value: "clear" });
    const fingerprint = cookie({ name: "_cfuvid", value: "fingerprint" });
    store.cookies = [
      cookie(),
      clearance,
      fingerprint,
      cookie({ name: "foreign", domain: "example.com" }),
    ];

    assert.equal(isThunderCookie(cookie()), true);
    assert.equal(isThunderCookie(cookie({ domain: ".en-thunderscans.com" })), true);
    assert.equal(isThunderCookie(cookie({ domain: "www.en-thunderscans.com" })), false);

    clearThunderSession(store);
    assert.deepEqual(store.cookies, [
      clearance,
      fingerprint,
      cookie({ name: "foreign", domain: "example.com" }),
    ]);
  });

  it("persists unexpired WebView cookies and atomically replaces old auth", () => {
    const store = new MemoryStore();
    store.cookies = [cookie({ value: "old" })];
    const fresh = cookie({ value: "fresh", expires: new Date(Date.now() + 60_000) });

    persistThunderCookies(store, [fresh, cookie({ domain: "evil.example" })]);
    assert.deepEqual(store.cookies, [fresh]);

    replaceThunderCookies(store, [cookie({ value: "new" })]);
    assert.equal(store.invalidations, 1);
    assert.equal(store.acceptances, 1);
    assert.deepEqual(store.cookies, [cookie({ value: "new" })]);
  });

  it("validates login from the final /profile/ URL rather than cookie presence", async () => {
    let finalUrl = "https://en-thunderscans.com/profile/";
    Object.assign(globalThis, {
      Application: {
        arrayBufferToUTF8String: (buffer: ArrayBuffer) => new TextDecoder().decode(buffer),
        scheduleRequest: async (_request: Request): Promise<[Response, ArrayBuffer]> => [
          { url: finalUrl, status: 200, headers: {}, cookies: [] },
          new TextEncoder().encode('<h1 class="profile-name">Reader One</h1>').buffer,
        ],
      },
    });
    const store = new MemoryStore();

    assert.deepEqual(await fetchAccountStatus(store), {
      authenticated: true,
      displayName: "Reader One",
    });

    finalUrl = "https://en-thunderscans.com/login/";
    store.cookies = [cookie()];
    assert.deepEqual(await fetchAccountStatus(store), { authenticated: false });
    assert.equal(store.invalidations, 1);
    assert.deepEqual(store.cookies, []);
  });

  it("treats network and rejected profile responses as logged out", async () => {
    Object.assign(globalThis, {
      Application: {
        scheduleRequest: async () => {
          throw new Error("offline");
        },
      },
    });
    assert.deepEqual(await fetchAccountStatus(), { authenticated: false });
  });

  it("rejects oversized profile responses before decoding them", async () => {
    let decodeCalls = 0;
    Object.assign(globalThis, {
      Application: {
        arrayBufferToUTF8String: () => {
          decodeCalls += 1;
          return "unexpected";
        },
        scheduleRequest: async (request: Request): Promise<[Response, ArrayBuffer]> => [
          { url: request.url, status: 200, headers: {}, cookies: [] },
          new ArrayBuffer(1 * 1_024 * 1_024 + 1),
        ],
      },
    });

    assert.deepEqual(await fetchAccountStatus(), { authenticated: false });
    assert.equal(decodeCalls, 0);
  });

  it("invalidates auth on an oversized rejected profile response", async () => {
    const store = new MemoryStore();
    store.cookies = [cookie()];
    Object.assign(globalThis, {
      Application: {
        scheduleRequest: async (request: Request): Promise<[Response, ArrayBuffer]> => [
          { url: request.url, status: 401, headers: {}, cookies: [] },
          new ArrayBuffer(1 * 1_024 * 1_024 + 1),
        ],
      },
    });

    assert.deepEqual(await fetchAccountStatus(store), { authenticated: false });
    assert.deepEqual(store.cookies, []);
    assert.equal(store.invalidations, 1);
  });
});
