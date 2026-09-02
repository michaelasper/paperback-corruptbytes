import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import type { Cookie, Request, Response } from "@paperback/types";

import { SourceHttpError } from "../shared/http.js";
import {
  ACCOUNT_URL,
  fetchQiMangaAccountStatus,
  fetchQiMangaTextWithSessionRefresh,
  hasQiMangaAuthCookies,
  invalidateQiMangaAuth,
  isQiMangaAuthCookieName,
  isQiMangaCookie,
  persistQiMangaCookies,
  QIMANGA_COOKIE_GENERATION_HEADER,
  qiMangaAuthCookiesForUrl,
  REFRESH_URL,
  refreshQiMangaSession,
  replaceQiMangaCookies,
  SIGN_OUT_URL,
  signOutQiManga,
  type QiMangaCookieStore,
} from "./auth.js";
import { QiMangaCookieInterceptor } from "./cookies.js";

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
  private generation = 0;

  get sensitiveCookieGeneration(): number {
    return this.generation;
  }

  invalidateAuthCookies(): void {
    this.invalidations += 1;
    this.generation += 1;
  }

  acceptAuthCookies(): void {
    this.acceptances += 1;
    this.generation += 1;
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
    assert.equal(isQiMangaCookie(cookie({ domain: "..qimanga.com" })), false);
    assert.equal(isQiMangaCookie(cookie({ domain: " qimanga.com" })), false);
    assert.equal(isQiMangaCookie(cookie({ name: "bad name" })), false);
    assert.equal(isQiMangaCookie(cookie({ value: "x".repeat(16 * 1_024 + 1) })), false);
    assert.equal(isQiMangaCookie(cookie({ value: "header\tvalue" })), false);
    assert.equal(isQiMangaCookie(cookie({ value: "value;injected=cookie" })), false);
    assert.equal(isQiMangaCookie(cookie({ value: "emoji-😀" })), false);
    assert.equal(isQiMangaCookie(cookie({ path: "relative" })), false);
    assert.equal(isQiMangaCookie(cookie({ path: "/unsafe\u007fpath" })), false);
    assert.equal(isQiMangaCookie(cookie({ path: "/unsafe\ud800path" })), false);
    assert.equal(isQiMangaCookie(cookie({ expires: new Date(Number.NaN) })), false);
    assert.equal(isQiMangaCookie(cookie({ expires: new Proxy(new Date(), {}) })), false);
    assert.equal(
      isQiMangaCookie(
        new Proxy(cookie(), {
          get: () => {
            throw new Error("malformed cookie accessor");
          },
        }),
      ),
      false,
    );
  });

  it("does not exempt arbitrary auth cookie names that merely start with cf", () => {
    assert.equal(isQiMangaAuthCookieName("cf_clearance"), false);
    assert.equal(isQiMangaAuthCookieName("__cf_bm"), false);
    assert.equal(isQiMangaAuthCookieName("_cfuvid"), false);
    assert.equal(isQiMangaAuthCookieName("cf_chl_rc_ni"), false);
    assert.equal(isQiMangaAuthCookieName("CF_CLEARANCE"), true);
    assert.equal(isQiMangaAuthCookieName("cf_chl_account_session"), true);
    assert.equal(isQiMangaAuthCookieName("cfSession"), true);
    assert.equal(isQiMangaAuthCookieName("cf_session"), true);
  });

  it("fails expiring cookies closed under a throwing or nonfinite runtime clock", () => {
    const originalNow = Date.now;
    try {
      for (const hostileNow of [
        () => {
          throw new Error("private clock failure");
        },
        () => Number.NaN,
      ]) {
        Date.now = originalNow;
        const expiring = cookie({
          name: "accessToken",
          expires: new Date(4_000_000_000_000),
        });
        const session = cookie({ name: "refreshToken", expires: undefined });
        Date.now = hostileNow;
        const store = new MemoryCookieStore();
        store.cookies = [expiring, session];

        assert.equal(hasQiMangaAuthCookies(store), true);
        assert.deepEqual(qiMangaAuthCookiesForUrl(store, "https://api.qimanga.com/api/v1/home"), {
          refreshToken: "secret",
        });
      }
    } finally {
      Date.now = originalNow;
    }
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

    const bounded = new MemoryCookieStore();
    persistQiMangaCookies(
      bounded,
      Array.from({ length: 1_100 }, (_, index) => cookie({ name: `token_${index}` })),
    );
    assert.equal(bounded.cookies.length, 64);

    const malformed = new MemoryCookieStore();
    persistQiMangaCookies(malformed, null as unknown as Cookie[]);
    persistQiMangaCookies(malformed, [null as unknown as Cookie]);
    assert.deepEqual(malformed.cookies, []);
  });

  it("exercises bounded batch persistence through the production cookie interceptor", () => {
    const secureState = new Map<string, unknown>();
    Object.assign(globalThis, {
      Application: {
        getSecureState: (key: string) => secureState.get(key),
        setSecureState: (value: unknown, key: string) => secureState.set(key, value),
      },
    });
    const store = new QiMangaCookieInterceptor();
    persistQiMangaCookies(
      store,
      Array.from({ length: 65 }, (_, index) =>
        cookie({
          name: `token_${index}`,
          value: `value-${index}`,
          expires: new Date(Date.now() + 60_000),
        }),
      ),
    );

    assert.equal(store.cookies.length, 64);
    assert.equal((secureState.get("qi_manga.secure_cookies") as Cookie[] | undefined)?.length, 64);
    assert.ok(
      store.cookies.every(({ expires }) => Object.getPrototypeOf(expires!) === Date.prototype),
    );
  });

  it("uses bounded batch persistence and tolerates unavailable custom cookie stores", () => {
    let batch: readonly Cookie[] | undefined;
    const batchedStore: QiMangaCookieStore = {
      cookies: [],
      sensitiveCookieGeneration: 0,
      setCookie: () => {
        throw new Error("The batch path should be preferred.");
      },
      setCookies: (cookies) => {
        batch = cookies;
      },
      deleteCookie: () => undefined,
    };
    const accepted = cookie();
    persistQiMangaCookies(batchedStore, [
      accepted,
      cookie({ domain: "evil.example" }),
      ...Array.from({ length: 64 }, (_, index) => cookie({ name: `extra_${index}` })),
    ]);
    assert.equal(batch?.length, 64);
    assert.deepEqual(batch?.[0], accepted);

    let deletions = 0;
    const unavailableStore: QiMangaCookieStore = {
      sensitiveCookieGeneration: 0,
      get cookies(): Cookie[] {
        throw new Error("private-cookie-material");
      },
      setCookie: () => undefined,
      deleteCookie: () => {
        deletions += 1;
      },
    };
    assert.equal(hasQiMangaAuthCookies(unavailableStore), false);
    assert.deepEqual(qiMangaAuthCookiesForUrl(unavailableStore, ACCOUNT_URL), {});
    assert.doesNotThrow(() => invalidateQiMangaAuth(unavailableStore));
    assert.equal(deletions, 0);
  });

  it("scopes duplicate auth-cookie names by exact API domain, path, and expiry", () => {
    const store = new MemoryCookieStore();
    store.cookies = [
      cookie({ name: "refreshToken", value: "root" }),
      cookie({
        name: "refreshToken",
        value: "refresh-only",
        domain: "api.qimanga.com",
        path: "/api/v1/auth/refresh",
      }),
      cookie({ name: "logoutToken", value: "logout", path: "/api/v1/auth/logout" }),
      cookie({ name: "expired", expires: new Date(Date.now() - 1) }),
      cookie({ name: "cf_clearance", value: "clear" }),
      cookie({ name: "foreign", domain: "example.com" }),
    ];

    assert.deepEqual(qiMangaAuthCookiesForUrl(store, REFRESH_URL), {
      refreshToken: "refresh-only",
    });
    assert.deepEqual(qiMangaAuthCookiesForUrl(store, SIGN_OUT_URL), {
      logoutToken: "logout",
      refreshToken: "root",
    });
    assert.deepEqual(qiMangaAuthCookiesForUrl(store, "https://evil.example/auth/refresh"), {});
    assert.deepEqual(
      qiMangaAuthCookiesForUrl(store, `https://api.qimanga.com/${"x".repeat(2_100)}`),
      {},
    );
  });

  it("fails closed when a custom store cannot unblock authentication", () => {
    class ThrowingAcceptStore extends MemoryCookieStore {
      override acceptAuthCookies(): void {
        throw new Error("private custom-store failure");
      }
    }
    const store = new ThrowingAcceptStore();
    assert.doesNotThrow(() =>
      replaceQiMangaCookies(store, [
        cookie({ name: "accessToken", value: "must-not-persist" }),
        cookie({ name: "cf_clearance", value: "challenge" }),
      ]),
    );
    assert.deepEqual(
      store.cookies.map(({ name, value }) => [name, value]),
      [["cf_clearance", "challenge"]],
    );
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

  it("does not let stale refreshes invalidate or accept a replacement session", async () => {
    for (const status of [204, 401]) {
      const store = new MemoryCookieStore();
      store.cookies = [cookie({ name: "accessToken", value: "account-a" })];
      let releaseRefresh!: () => void;
      let markStarted!: () => void;
      const gate = new Promise<void>((resolve) => {
        releaseRefresh = resolve;
      });
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      Object.assign(globalThis, {
        Application: {
          scheduleRequest: async (request: Request): Promise<[Response, ArrayBuffer]> => {
            markStarted();
            await gate;
            return [{ url: request.url, status, headers: {}, cookies: [] }, new ArrayBuffer(0)];
          },
        },
      });

      const stale = refreshQiMangaSession(store);
      await started;
      replaceQiMangaCookies(store, [cookie({ name: "accessToken", value: "account-b" })]);
      releaseRefresh();

      await assert.rejects(stale, /could not be completed safely/i);
      assert.deepEqual(
        store.cookies.map(({ value }) => value),
        ["account-b"],
      );
      assert.equal(store.invalidations, 1);
      assert.equal(store.acceptances, 1);
    }
  });

  it("coalesces refreshes by authentication generation rather than across logins", async () => {
    const store = new MemoryCookieStore();
    store.cookies = [cookie({ name: "accessToken", value: "account-a" })];
    let refreshCalls = 0;
    let releaseOld!: () => void;
    let markOldStarted!: () => void;
    const oldGate = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    const oldStarted = new Promise<void>((resolve) => {
      markOldStarted = resolve;
    });
    Object.assign(globalThis, {
      Application: {
        scheduleRequest: async (request: Request): Promise<[Response, ArrayBuffer]> => {
          refreshCalls += 1;
          if (refreshCalls === 1) {
            markOldStarted();
            await oldGate;
          }
          return [{ url: request.url, status: 204, headers: {}, cookies: [] }, new ArrayBuffer(0)];
        },
      },
    });

    const oldRefresh = refreshQiMangaSession(store);
    await oldStarted;
    replaceQiMangaCookies(store, [cookie({ name: "accessToken", value: "account-b" })]);
    const currentRefresh = refreshQiMangaSession(store);
    assert.notEqual(currentRefresh, oldRefresh);
    await currentRefresh;
    releaseOld();
    await assert.rejects(oldRefresh, /could not be completed safely/i);

    assert.equal(refreshCalls, 2);
    assert.deepEqual(
      store.cookies.map(({ value }) => value),
      ["account-b"],
    );
    assert.equal(store.invalidations, 1);
    assert.equal(store.acceptances, 2);
  });

  it("does not replay a stale initial rejection with a newer session", async () => {
    const store = new MemoryCookieStore();
    store.cookies = [cookie({ value: "account-a" })];
    let resourceCalls = 0;
    let refreshCalls = 0;
    let releaseInitial!: () => void;
    let markInitialStarted!: () => void;
    const initialGate = new Promise<void>((resolve) => {
      releaseInitial = resolve;
    });
    const initialStarted = new Promise<void>((resolve) => {
      markInitialStarted = resolve;
    });
    Object.assign(globalThis, {
      Application: {
        scheduleRequest: async (request: Request): Promise<[Response, ArrayBuffer]> => {
          if (request.url === REFRESH_URL) {
            refreshCalls += 1;
          } else {
            resourceCalls += 1;
          }
          markInitialStarted();
          await initialGate;
          return [{ url: request.url, status: 401, headers: {}, cookies: [] }, new ArrayBuffer(0)];
        },
      },
    });

    const pending = fetchQiMangaTextWithSessionRefresh(store, {
      url: "https://api.qimanga.com/api/v1/home",
      method: "GET",
    });
    await initialStarted;
    replaceQiMangaCookies(store, [cookie({ value: "account-b" })]);
    releaseInitial();
    await assert.rejects(pending, /could not be completed safely/i);

    assert.equal(resourceCalls, 1);
    assert.equal(refreshCalls, 0);
    assert.deepEqual(
      store.cookies.map(({ value }) => value),
      ["account-b"],
    );
  });

  it("does not let a stale replay response invalidate a replacement session", async () => {
    for (const replayStatus of [200, 401]) {
      const store = new MemoryCookieStore();
      store.cookies = [cookie({ value: "account-a" })];
      let resourceCalls = 0;
      let releaseReplay!: () => void;
      let markReplayStarted!: () => void;
      const replayGate = new Promise<void>((resolve) => {
        releaseReplay = resolve;
      });
      const replayStarted = new Promise<void>((resolve) => {
        markReplayStarted = resolve;
      });
      Object.assign(globalThis, {
        Application: {
          arrayBufferToUTF8String: (buffer: ArrayBuffer) => new TextDecoder().decode(buffer),
          scheduleRequest: async (request: Request): Promise<[Response, ArrayBuffer]> => {
            if (request.url === REFRESH_URL) {
              return [
                { url: request.url, status: 204, headers: {}, cookies: [] },
                new ArrayBuffer(0),
              ];
            }
            resourceCalls += 1;
            if (resourceCalls === 1) {
              return [
                { url: request.url, status: 401, headers: {}, cookies: [] },
                new ArrayBuffer(0),
              ];
            }
            markReplayStarted();
            await replayGate;
            return [
              { url: request.url, status: replayStatus, headers: {}, cookies: [] },
              new TextEncoder().encode('{"account":"a"}').buffer,
            ];
          },
        },
      });

      const pending = fetchQiMangaTextWithSessionRefresh(store, {
        url: "https://api.qimanga.com/api/v1/home",
        method: "GET",
      });
      await replayStarted;
      replaceQiMangaCookies(store, [cookie({ value: "account-b" })]);
      releaseReplay();
      await assert.rejects(pending);

      assert.deepEqual(
        store.cookies.map(({ value }) => value),
        ["account-b"],
      );
      assert.equal(store.invalidations, 1);
      assert.equal(store.acceptances, 2);
    }
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

  it("rejects malformed refresh statuses and clears the unverifiable session", async () => {
    for (const status of [Number.NaN, 200.5, Number.POSITIVE_INFINITY]) {
      const store = new MemoryCookieStore();
      store.cookies = [cookie({ name: "refreshToken" })];
      Object.assign(globalThis, {
        Application: {
          scheduleRequest: async (request: Request): Promise<[Response, ArrayBuffer]> => [
            { url: request.url, status, headers: {}, cookies: [] },
            new ArrayBuffer(0),
          ],
        },
      });

      await assert.rejects(refreshQiMangaSession(store));
      assert.deepEqual(store.cookies, []);
      assert.equal(store.invalidations, 1);
      assert.equal(store.acceptances, 0);
    }
  });

  it("times out refreshes, clears auth, and leaves late responses generation-blocked", async () => {
    const store = new MemoryCookieStore();
    store.cookies = [cookie({ name: "refreshToken", value: "old" })];
    Object.assign(globalThis, {
      Application: {
        scheduleRequest: async (): Promise<[Response, ArrayBuffer]> => new Promise(() => undefined),
      },
    });

    await assert.rejects(refreshQiMangaSession(store, 5), /could not be completed safely/i);
    assert.deepEqual(store.cookies, []);
    assert.equal(store.invalidations, 1);
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
        cookies: {
          display: "safe",
          numeric: 42,
          injected: "value;other=secret",
        } as unknown as Record<string, string>,
      }),
      /status 401/i,
    );
    assert.deepEqual(
      requests.map((request) => request.url),
      ["https://api.qimanga.com/api/v1/series/title/purchase"],
    );
    assert.deepEqual(requests[0]?.cookies, { display: "safe" });
    assert.equal(store.cookies.length, 1);
  });

  it("bounds hostile caller headers and cookies before cloning a request", async () => {
    const store = new MemoryCookieStore();
    const requests: Request[] = [];
    let headerReads = 0;
    let cookieReads = 0;
    const headers: Record<string, unknown> = {};
    const cookies: Record<string, unknown> = {};
    for (let index = 0; index < 1_100; index += 1) {
      Object.defineProperty(headers, `x-invalid-${index}`, {
        enumerable: true,
        get: () => {
          headerReads += 1;
          return 42;
        },
      });
      Object.defineProperty(cookies, `invalid_${index}`, {
        enumerable: true,
        get: () => {
          cookieReads += 1;
          return 42;
        },
      });
    }
    Object.assign(globalThis, {
      Application: {
        scheduleRequest: async (request: Request): Promise<[Response, ArrayBuffer]> => {
          requests.push(request);
          return [{ url: request.url, status: 401, headers: {}, cookies: [] }, new ArrayBuffer(0)];
        },
      },
    });

    await assert.rejects(
      fetchQiMangaTextWithSessionRefresh(store, {
        url: "https://api.qimanga.com/api/v1/home",
        method: "POST",
        headers: headers as Record<string, string>,
        cookies: cookies as Record<string, string>,
      }),
      /status 401/i,
    );
    assert.equal(headerReads, 256);
    assert.equal(cookieReads, 1_024);
    assert.deepEqual(requests[0]?.headers, { [QIMANGA_COOKIE_GENERATION_HEADER]: "0" });
    assert.equal("cookies" in (requests[0] as Request), false);
  });

  it("does not normalize a malformed method into an idempotent replay", async () => {
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
        url: "https://api.qimanga.com/api/v1/home",
        method: " GET ",
      }),
      /status 401/i,
    );
    assert.equal(requests.length, 1);
    assert.equal(store.invalidations, 0);
  });

  it("reconstructs classified transport errors without retaining causes or forged fields", async () => {
    const store = new MemoryCookieStore();
    const forged = new SourceHttpError("Qi Manga", 429) as SourceHttpError & {
      cause?: unknown;
      authentication?: string;
    };
    forged.cause = new Error("cookie=private-session");
    forged.authentication = "private-session";
    Object.assign(globalThis, {
      Application: {
        scheduleRequest: async () => {
          throw forged;
        },
      },
    });

    await assert.rejects(
      fetchQiMangaTextWithSessionRefresh(store, {
        url: "https://api.qimanga.com/api/v1/home",
        method: "GET",
      }),
      (error: unknown) => {
        assert.ok(error instanceof SourceHttpError);
        assert.notEqual(error, forged);
        assert.equal(error.status, 429);
        assert.equal(error.cause, undefined);
        assert.equal("authentication" in error, false);
        return true;
      },
    );
  });

  it("never retains transport errors that could quote authentication cookies", async () => {
    const store = new MemoryCookieStore();
    store.cookies = [cookie({ name: "refreshToken", value: "top-secret-token" })];
    Object.assign(globalThis, {
      Application: {
        scheduleRequest: async (request: Request): Promise<[Response, ArrayBuffer]> => {
          if (request.url === REFRESH_URL) {
            throw new Error(`transport dumped ${String(request.cookies?.refreshToken)}`);
          }
          return [{ url: request.url, status: 401, headers: {}, cookies: [] }, new ArrayBuffer(0)];
        },
      },
    });

    await assert.rejects(
      fetchQiMangaTextWithSessionRefresh(store, {
        url: "https://api.qimanga.com/api/v1/home",
        method: "GET",
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /could not be completed safely/i);
        assert.doesNotMatch(error.message, /top-secret-token/i);
        assert.equal(error.cause, undefined);
        return true;
      },
    );
    assert.deepEqual(store.cookies, []);
    assert.equal(store.invalidations, 1);
  });

  it("clears unverifiable sessions when refresh transport cannot be trusted or bounded", async () => {
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
      assert.deepEqual(store.cookies, []);
      assert.equal(store.invalidations, 1);
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

  it("omits malformed Unicode from account display text and rejects it in identity fields", async () => {
    installApplication(200, '{"id":42,"displayName":"bad\\ud800name"}');
    assert.deepEqual(await fetchQiMangaAccountStatus(), { authenticated: true });

    installApplication(200, '{"id":"bad\\ud800identity","displayName":"Reader"}');
    assert.deepEqual(await fetchQiMangaAccountStatus(), { authenticated: false });
    installApplication(200, '{"id":0,"displayName":"Reader"}');
    assert.deepEqual(await fetchQiMangaAccountStatus(), { authenticated: false });
    installApplication(200, '{"id":" padded ","displayName":"Reader"}');
    assert.deepEqual(await fetchQiMangaAccountStatus(), { authenticated: false });
    installApplication(200, '{"id":"reader\\u200b42","displayName":"Reader"}');
    assert.deepEqual(await fetchQiMangaAccountStatus(), { authenticated: false });
    installApplication(200, '{"id":"e\\u0301","displayName":"Reader"}');
    assert.deepEqual(await fetchQiMangaAccountStatus(), { authenticated: false });
    installApplication(200, '{"id":42,"displayName":"bad\\ufffename"}');
    assert.deepEqual(await fetchQiMangaAccountStatus(), { authenticated: true });
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

  it("revalidates the current account when an older account response arrives late", async () => {
    const store = new MemoryCookieStore();
    store.cookies = [cookie({ value: "account-a" })];
    const observedCookies: (Record<string, string> | undefined)[] = [];
    let accountCalls = 0;
    let releaseOld!: () => void;
    let markOldStarted!: () => void;
    const oldGate = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    const oldStarted = new Promise<void>((resolve) => {
      markOldStarted = resolve;
    });
    Object.assign(globalThis, {
      Application: {
        arrayBufferToUTF8String: (buffer: ArrayBuffer) => new TextDecoder().decode(buffer),
        scheduleRequest: async (request: Request): Promise<[Response, ArrayBuffer]> => {
          accountCalls += 1;
          observedCookies.push(request.cookies);
          if (accountCalls === 1) {
            markOldStarted();
            await oldGate;
            return [
              { url: request.url, status: 403, headers: {}, cookies: [] },
              new ArrayBuffer(0),
            ];
          }
          return [
            { url: request.url, status: 200, headers: {}, cookies: [] },
            new TextEncoder().encode('{"id":2,"displayName":"Account B"}').buffer,
          ];
        },
      },
    });

    const pending = fetchQiMangaAccountStatus(store);
    await oldStarted;
    replaceQiMangaCookies(store, [cookie({ value: "account-b" })]);
    releaseOld();

    assert.deepEqual(await pending, { authenticated: true, displayName: "Account B" });
    assert.deepEqual(observedCookies, [{ accessToken: "account-a" }, { accessToken: "account-b" }]);
    assert.deepEqual(
      store.cookies.map(({ value }) => value),
      ["account-b"],
    );
    assert.equal(store.invalidations, 1);
  });

  it("does not report an older successful account response after logout", async () => {
    const store = new MemoryCookieStore();
    store.cookies = [cookie({ value: "account-a" })];
    let accountCalls = 0;
    let releaseOld!: () => void;
    let markOldStarted!: () => void;
    const oldGate = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    const oldStarted = new Promise<void>((resolve) => {
      markOldStarted = resolve;
    });
    Object.assign(globalThis, {
      Application: {
        arrayBufferToUTF8String: (buffer: ArrayBuffer) => new TextDecoder().decode(buffer),
        scheduleRequest: async (request: Request): Promise<[Response, ArrayBuffer]> => {
          accountCalls += 1;
          if (accountCalls === 1) {
            markOldStarted();
            await oldGate;
            return [
              { url: request.url, status: 200, headers: {}, cookies: [] },
              new TextEncoder().encode('{"id":1,"displayName":"Account A"}').buffer,
            ];
          }
          return [{ url: request.url, status: 401, headers: {}, cookies: [] }, new ArrayBuffer(0)];
        },
      },
    });

    const pending = fetchQiMangaAccountStatus(store);
    await oldStarted;
    invalidateQiMangaAuth(store);
    releaseOld();

    assert.deepEqual(await pending, { authenticated: false });
    assert.deepEqual(store.cookies, []);
    assert.equal(accountCalls, 2);
  });

  it("does not expose an account when authentication changes during decoding", async () => {
    const store = new MemoryCookieStore();
    store.cookies = [cookie({ value: "account-a" })];
    Object.assign(globalThis, {
      Application: {
        arrayBufferToUTF8String: (buffer: ArrayBuffer) => {
          replaceQiMangaCookies(store, [cookie({ value: "account-b" })]);
          return new TextDecoder().decode(buffer);
        },
        scheduleRequest: async (request: Request): Promise<[Response, ArrayBuffer]> => [
          { url: request.url, status: 200, headers: {}, cookies: [] },
          new TextEncoder().encode('{"id":1,"displayName":"Account A"}').buffer,
        ],
      },
    });

    assert.deepEqual(await fetchQiMangaAccountStatus(store), { authenticated: false });
    assert.deepEqual(
      store.cookies.map(({ value }) => value),
      ["account-b"],
    );
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
    application.setResponse(Number.NaN, '{"id":42,"displayName":"Forged Success"}');
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

    installApplication(200, '{"id":42}', `https://api.qimanga.com/${"x".repeat(2_100)}`);
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

  it("never sends logout credentials with a malformed runtime generation", async () => {
    const application = installApplication(204, "");
    const store = new MemoryCookieStore();
    store.cookies = [cookie()];
    Object.defineProperty(store, "sensitiveCookieGeneration", {
      configurable: true,
      value: Number.NaN,
    });

    await signOutQiManga(store);

    assert.equal(application.requests.length, 1);
    assert.equal(application.requests[0]?.cookies, undefined);
    assert.deepEqual(store.cookies, []);
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
        headers: {
          "cache-control": "no-store",
          "x-paperback-qimanga-cookie-generation": "0",
        },
        cookies: { accessToken: "secret" },
      },
    ]);
  });
});
