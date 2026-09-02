import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import type { Cookie, Request, Response } from "@paperback/types";

import {
  ACCOUNT_URL,
  fetchQiMangaAccountStatus,
  invalidateQiMangaAuth,
  isQiMangaAuthCookieName,
  isQiMangaCookie,
  persistQiMangaCookies,
  replaceQiMangaCookies,
  SIGN_OUT_URL,
  signOutQiManga,
  type QiMangaCookieStore,
} from "./auth.js";

const originalApplication = globalThis.Application;

const cookie = (overrides: Partial<Cookie> = {}): Cookie => ({
  name: "accessToken",
  value: "secret",
  domain: ".qimanga.com",
  path: "/",
  expires: new Date(Date.now() + 60_000),
  ...overrides,
});

class MemoryCookieStore implements QiMangaCookieStore {
  cookies: Cookie[] = [];
  invalidations = 0;
  acceptances = 0;

  invalidateAuthCookies(): void {
    this.invalidations += 1;
  }

  acceptAuthCookies(): void {
    this.acceptances += 1;
  }

  setCookie(value: Cookie): void {
    this.cookies = this.cookies.filter(
      (candidate) =>
        candidate.name !== value.name ||
        candidate.domain !== value.domain ||
        (candidate.path ?? "/") !== (value.path ?? "/"),
    );
    this.cookies.push(value);
  }

  deleteCookie(value: Cookie): void {
    this.cookies = this.cookies.filter(
      (candidate) =>
        candidate.name !== value.name ||
        candidate.domain !== value.domain ||
        (candidate.path ?? "/") !== (value.path ?? "/"),
    );
  }
}

const installApplication = (
  status: number,
  body: string,
  responseUrl?: string,
): { requests: Request[]; setResponse(status: number, body: string): void } => {
  const requests: Request[] = [];
  let currentStatus = status;
  let currentBody = body;
  Object.assign(globalThis, {
    Application: {
      arrayBufferToUTF8String: (buffer: ArrayBuffer) => new TextDecoder().decode(buffer),
      scheduleRequest: async (request: Request): Promise<[Response, ArrayBuffer]> => {
        requests.push(request);
        return [
          { url: responseUrl ?? request.url, status: currentStatus, headers: {}, cookies: [] },
          new TextEncoder().encode(currentBody).buffer,
        ];
      },
    },
  });
  return {
    requests,
    setResponse(nextStatus, nextBody) {
      currentStatus = nextStatus;
      currentBody = nextBody;
    },
  };
};

afterEach(() => Object.assign(globalThis, { Application: originalApplication }));

describe("Qi Manga account cookies", () => {
  it("accepts only the site's explicit cookie domains", () => {
    assert.equal(isQiMangaCookie(cookie()), true);
    assert.equal(isQiMangaCookie(cookie({ domain: "api.qimanga.com" })), true);
    assert.equal(isQiMangaCookie(cookie({ domain: "www.qimanga.com" })), false);
    assert.equal(isQiMangaCookie(cookie({ domain: "media.qimanga.com" })), false);
    assert.equal(isQiMangaCookie(cookie({ domain: "notqimanga.com" })), false);
    assert.equal(isQiMangaCookie(cookie({ name: "bad name" })), false);
    assert.equal(isQiMangaCookie(cookie({ value: "x".repeat(16 * 1_024 + 1) })), false);
    assert.equal(isQiMangaCookie(cookie({ path: "relative" })), false);
    assert.equal(isQiMangaCookie(cookie({ expires: new Date(Number.NaN) })), false);
  });

  it("does not exempt arbitrary auth cookie names that merely start with cf", () => {
    assert.equal(isQiMangaAuthCookieName("cf_clearance"), false);
    assert.equal(isQiMangaAuthCookieName("__cf_bm"), false);
    assert.equal(isQiMangaAuthCookieName("_cfuvid"), false);
    assert.equal(isQiMangaAuthCookieName("cf_chl_rc_ni"), false);
    assert.equal(isQiMangaAuthCookieName("cfSession"), true);
    assert.equal(isQiMangaAuthCookieName("cf_session"), true);
  });

  it("persists only unexpired first-party cookies", () => {
    const store = new MemoryCookieStore();
    const accepted = cookie();
    store.cookies = [cookie({ name: "stale" })];
    persistQiMangaCookies(store, [
      accepted,
      cookie({ name: "stale", expires: new Date(Date.now() - 1) }),
      cookie({ name: "third-party", domain: "example.com" }),
    ]);
    assert.deepEqual(store.cookies, [accepted]);
  });

  it("replaces auth atomically while retaining Cloudflare clearance", () => {
    const store = new MemoryCookieStore();
    const clearance = cookie({ name: "cf_clearance", value: "clear" });
    store.cookies = [cookie({ value: "old" }), clearance];
    const replacement = cookie({ value: "new" });

    replaceQiMangaCookies(store, [replacement]);

    assert.equal(store.invalidations, 1);
    assert.equal(store.acceptances, 1);
    assert.deepEqual(store.cookies, [clearance, replacement]);

    invalidateQiMangaAuth(store);
    assert.deepEqual(store.cookies, [clearance]);
  });
});

describe("Qi Manga account status", () => {
  it("validates a current user without retaining private profile fields", async () => {
    const application = installApplication(
      200,
      JSON.stringify({
        id: 42,
        username: "reader",
        displayName: "Reader One",
        email: "private@example.com",
        balance: 500,
      }),
    );

    assert.deepEqual(await fetchQiMangaAccountStatus(), {
      authenticated: true,
      displayName: "Reader One",
    });
    assert.deepEqual(application.requests, [
      { url: ACCOUNT_URL, method: "GET", headers: { "cache-control": "no-store" } },
    ]);
  });

  it("invalidates rejected sessions and treats malformed success bodies as logged out", async () => {
    const application = installApplication(401, '{"message":"Unauthorized"}');
    const store = new MemoryCookieStore();
    store.cookies = [cookie()];

    assert.deepEqual(await fetchQiMangaAccountStatus(store), { authenticated: false });
    assert.deepEqual(store.cookies, []);
    assert.equal(store.invalidations, 1);

    application.setResponse(200, "not-json");
    assert.deepEqual(await fetchQiMangaAccountStatus(), { authenticated: false });
    application.setResponse(200, '{"username":"missing-id"}');
    assert.deepEqual(await fetchQiMangaAccountStatus(), { authenticated: false });
  });

  it("rejects foreign and oversized account responses before decoding", async () => {
    let decodeCalls = 0;
    installApplication(200, '{"id":42}', "https://evil.example/users/me");
    Object.assign(globalThis.Application, {
      arrayBufferToUTF8String: () => {
        decodeCalls += 1;
        return '{"id":42}';
      },
    });
    assert.deepEqual(await fetchQiMangaAccountStatus(), { authenticated: false });
    assert.equal(decodeCalls, 0);

    Object.assign(globalThis, {
      Application: {
        arrayBufferToUTF8String: () => {
          decodeCalls += 1;
          return "unexpected";
        },
        scheduleRequest: async (request: Request): Promise<[Response, ArrayBuffer]> => [
          { url: request.url, status: 200, headers: {}, cookies: [] },
          new ArrayBuffer(256 * 1_024 + 1),
        ],
      },
    });
    assert.deepEqual(await fetchQiMangaAccountStatus(), { authenticated: false });
    assert.equal(decodeCalls, 0);
  });

  it("signs out server-side and always clears the local session", async () => {
    const application = installApplication(500, "failed");
    const store = new MemoryCookieStore();
    const clearance = cookie({ name: "cf_clearance", value: "clear" });
    store.cookies = [cookie(), clearance];

    await signOutQiManga(store);

    assert.deepEqual(store.cookies, [clearance]);
    assert.equal(store.invalidations, 1);
    assert.deepEqual(application.requests, [
      {
        url: SIGN_OUT_URL,
        method: "POST",
        headers: { "cache-control": "no-store" },
        cookies: { accessToken: "secret" },
      },
    ]);
  });
});
