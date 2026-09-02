import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import type { Cookie, Request, Response } from "@paperback/types";

import {
  ACCOUNT_URL,
  fetchQiMangaAccountStatus,
  fetchQiMangaTextWithSessionRefresh,
  invalidateQiMangaAuth,
  isQiMangaAuthCookieName,
  isQiMangaCookie,
  persistQiMangaCookies,
  REFRESH_URL,
  refreshQiMangaSession,
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

describe("Qi Manga session refresh", () => {
  it("coalesces refreshes and retries an idempotent request once", async () => {
    const store = new MemoryCookieStore();
    store.cookies = [cookie({ name: "refreshToken" })];
    let refreshCalls = 0;
    let resourceCalls = 0;
    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    Object.assign(globalThis, {
      Application: {
        arrayBufferToUTF8String: (buffer: ArrayBuffer) => new TextDecoder().decode(buffer),
        scheduleRequest: async (request: Request): Promise<[Response, ArrayBuffer]> => {
          if (request.url === REFRESH_URL) {
            refreshCalls += 1;
            await refreshGate;
            return [
              { url: request.url, status: 204, headers: {}, cookies: [] },
              new ArrayBuffer(0),
            ];
          }
          resourceCalls += 1;
          const status = resourceCalls <= 2 ? 401 : 200;
          return [
            { url: request.url, status, headers: {}, cookies: [] },
            new TextEncoder().encode(status === 200 ? '{"ok":true}' : "unauthorized").buffer,
          ];
        },
      },
    });

    const firstRefresh = refreshQiMangaSession(store);
    const secondRefresh = refreshQiMangaSession(store);
    assert.equal(firstRefresh, secondRefresh);
    releaseRefresh();
    await Promise.all([firstRefresh, secondRefresh]);
    assert.equal(refreshCalls, 1);

    const requests = await Promise.all([
      fetchQiMangaTextWithSessionRefresh(store, {
        url: "https://api.qimanga.com/api/v1/home",
        method: "GET",
      }),
      fetchQiMangaTextWithSessionRefresh(store, {
        url: "https://api.qimanga.com/api/v1/series",
        method: "GET",
      }),
    ]);
    assert.deepEqual(requests, ['{"ok":true}', '{"ok":true}']);
    assert.equal(refreshCalls, 2);
    assert.equal(resourceCalls, 4);
  });

  it("invalidates a definitively rejected refresh and never loops", async () => {
    const rejectedStore = new MemoryCookieStore();
    rejectedStore.cookies = [cookie({ name: "refreshToken" })];
    const rejectedRequests: Request[] = [];
    Object.assign(globalThis, {
      Application: {
        arrayBufferToUTF8String: (buffer: ArrayBuffer) => new TextDecoder().decode(buffer),
        scheduleRequest: async (request: Request): Promise<[Response, ArrayBuffer]> => {
          rejectedRequests.push(request);
          return [
            { url: request.url, status: 401, headers: {}, cookies: [] },
            new TextEncoder().encode("unauthorized").buffer,
          ];
        },
      },
    });

    await assert.rejects(
      fetchQiMangaTextWithSessionRefresh(rejectedStore, {
        url: "https://api.qimanga.com/api/v1/home",
        method: "GET",
      }),
      /status 401/i,
    );
    assert.deepEqual(
      rejectedRequests.map((request) => request.url),
      ["https://api.qimanga.com/api/v1/home", REFRESH_URL],
    );
    assert.deepEqual(rejectedStore.cookies, []);
    assert.equal(rejectedStore.invalidations, 1);

    const retryStore = new MemoryCookieStore();
    retryStore.cookies = [cookie({ name: "refreshToken" })];
    let refreshCalls = 0;
    let resourceCalls = 0;
    Object.assign(globalThis.Application, {
      scheduleRequest: async (request: Request): Promise<[Response, ArrayBuffer]> => {
        const isRefresh = request.url === REFRESH_URL;
        if (isRefresh) refreshCalls += 1;
        else resourceCalls += 1;
        return [
          { url: request.url, status: isRefresh ? 204 : 401, headers: {}, cookies: [] },
          new ArrayBuffer(0),
        ];
      },
    });

    await assert.rejects(
      fetchQiMangaTextWithSessionRefresh(retryStore, {
        url: "https://api.qimanga.com/api/v1/home",
        method: "GET",
      }),
      /status 401/i,
    );
    assert.equal(refreshCalls, 1);
    assert.equal(resourceCalls, 2);
    assert.equal(retryStore.invalidations, 1);
  });

  it("never refreshes or replays a non-idempotent request", async () => {
    const store = new MemoryCookieStore();
    store.cookies = [cookie({ name: "refreshToken" })];
    const requests: Request[] = [];
    Object.assign(globalThis, {
      Application: {
        arrayBufferToUTF8String: (buffer: ArrayBuffer) => new TextDecoder().decode(buffer),
        scheduleRequest: async (request: Request): Promise<[Response, ArrayBuffer]> => {
          requests.push(request);
          return [{ url: request.url, status: 401, headers: {}, cookies: [] }, new ArrayBuffer(0)];
        },
      },
    });

    await assert.rejects(
      fetchQiMangaTextWithSessionRefresh(store, {
        url: "https://api.qimanga.com/api/v1/series/title/purchase",
        method: "POST",
      }),
      /status 401/i,
    );
    assert.deepEqual(
      requests.map((request) => request.url),
      ["https://api.qimanga.com/api/v1/series/title/purchase"],
    );
    assert.equal(store.cookies.length, 1);
  });

  it("preserves cookies when refresh transport cannot be trusted or bounded", async () => {
    for (const boundary of ["redirect", "oversized"] as const) {
      const store = new MemoryCookieStore();
      store.cookies = [cookie({ name: "refreshToken" })];
      let decodeCalls = 0;
      Object.assign(globalThis, {
        Application: {
          arrayBufferToUTF8String: () => {
            decodeCalls += 1;
            return "unexpected";
          },
          scheduleRequest: async (request: Request): Promise<[Response, ArrayBuffer]> => {
            if (request.url !== REFRESH_URL) {
              return [
                { url: request.url, status: 401, headers: {}, cookies: [] },
                new ArrayBuffer(0),
              ];
            }
            return [
              {
                url: boundary === "redirect" ? "https://evil.example/auth/refresh" : request.url,
                status: 200,
                headers: {},
                cookies: [],
              },
              boundary === "oversized" ? new ArrayBuffer(256 * 1_024 + 1) : new ArrayBuffer(0),
            ];
          },
        },
      });

      await assert.rejects(
        fetchQiMangaTextWithSessionRefresh(store, {
          url: "https://api.qimanga.com/api/v1/home",
          method: "GET",
        }),
        boundary === "redirect" ? /not trusted/i : /too large/i,
      );
      assert.equal(store.cookies.length, 1);
      assert.equal(store.invalidations, 0);
      assert.equal(decodeCalls, 0);
    }
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

  it("refreshes an expired account session before declaring it logged out", async () => {
    const store = new MemoryCookieStore();
    store.cookies = [cookie({ name: "refreshToken" })];
    let accountCalls = 0;
    const requests: Request[] = [];
    Object.assign(globalThis, {
      Application: {
        arrayBufferToUTF8String: (buffer: ArrayBuffer) => new TextDecoder().decode(buffer),
        scheduleRequest: async (request: Request): Promise<[Response, ArrayBuffer]> => {
          requests.push(request);
          if (request.url === REFRESH_URL) {
            return [
              { url: request.url, status: 204, headers: {}, cookies: [] },
              new ArrayBuffer(0),
            ];
          }
          accountCalls += 1;
          const status = accountCalls === 1 ? 401 : 200;
          return [
            { url: request.url, status, headers: {}, cookies: [] },
            new TextEncoder().encode(status === 200 ? '{"id":42,"displayName":"Reader"}' : "")
              .buffer,
          ];
        },
      },
    });

    assert.deepEqual(await fetchQiMangaAccountStatus(store), {
      authenticated: true,
      displayName: "Reader",
    });
    assert.deepEqual(
      requests.map((request) => [request.method, request.url]),
      [
        ["GET", ACCOUNT_URL],
        ["POST", REFRESH_URL],
        ["GET", ACCOUNT_URL],
      ],
    );
    assert.equal(store.invalidations, 0);
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
