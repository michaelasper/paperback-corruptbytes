import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { Cookie, Request, Response } from "@paperback/types";

import { SecureCookieInterceptor } from "./cookies.js";

const originalApplication = globalThis.Application;
const STATE_KEY = "test_source.secure_cookies";
let secureState = new Map<string, unknown>();

const cookie = (overrides: Partial<Cookie> = {}): Cookie => ({
  name: "reader_session",
  value: "secret",
  domain: ".reader.example",
  path: "/",
  ...overrides,
});

const isAcceptedCookie = (value: Cookie): boolean => {
  const domain = value.domain.trim().replace(/^\.+/, "").toLowerCase();
  return domain === "reader.example" || domain === "api.reader.example";
};

const isSensitiveCookieName = (name: string): boolean => name.startsWith("reader_");

const create = (
  limits: { maxCookieCount?: number; maxCookieBytes?: number } = {},
): SecureCookieInterceptor =>
  new SecureCookieInterceptor({
    stateKey: STATE_KEY,
    generationHeader: "x-paperback-test-cookie-generation",
    isTrustedRequestUrl: (url) => /^https:\/\/(?:api\.)?reader\.example\//.test(url),
    isAcceptedCookie,
    isSensitiveCookieName,
    shouldStripCookieName: (name) => isSensitiveCookieName(name) || name === "cf_clearance",
    ...limits,
  });

beforeEach(() => {
  secureState = new Map();
  Object.assign(globalThis, {
    Application: {
      getSecureState: (key: string) => secureState.get(key),
      setSecureState: (value: unknown, key: string) => secureState.set(key, value),
    },
  });
});

afterEach(() => {
  Object.assign(globalThis, { Application: originalApplication });
});

describe("SecureCookieInterceptor", () => {
  it("persists session cookies and restores only sanitized intrinsic dates", () => {
    class MisleadingDate extends Date {
      override getTime(): number {
        return Number.NaN;
      }
    }
    const expires = new MisleadingDate(Date.now() + 60_000);
    const first = create();
    first.setCookie(cookie({ expires }));

    const stored = secureState.get(STATE_KEY) as Cookie[];
    assert.equal(stored.length, 1);
    assert.equal(stored[0]?.expires?.toISOString(), Date.prototype.toISOString.call(expires));
    assert.equal(Object.getPrototypeOf(stored[0]?.expires as Date), Date.prototype);

    secureState.set(STATE_KEY, [
      { ...cookie({ name: "bad-created" }), created: "not-a-date" },
      { ...cookie({ name: "null-created" }), created: null },
      { ...cookie({ name: "null-expires" }), expires: null },
      { ...cookie(), expires: Date.prototype.toISOString.call(expires) },
    ]);
    const restored = create();
    assert.equal(restored.cookies.length, 1);
    assert.ok(restored.cookies[0]?.expires instanceof Date);
    assert.equal(
      restored.cookies[0]?.expires?.toISOString(),
      Date.prototype.toISOString.call(expires),
    );
  });

  it("fails expiring cookies closed while retaining session cookies under a hostile clock", async () => {
    const originalNow = Date.now;
    try {
      for (const hostileNow of [
        () => {
          throw new Error("private clock failure");
        },
        () => Number.POSITIVE_INFINITY,
      ]) {
        Date.now = hostileNow;
        const source = create();
        source.setCookies([
          cookie({ expires: new Date(4_000_000_000_000) }),
          cookie({ name: "reader_session_persistent" }),
        ]);

        assert.deepEqual(source.cookies, [cookie({ name: "reader_session_persistent" })]);
        const request = await source.interceptRequest({
          url: "https://api.reader.example/profile",
          method: "GET",
        });
        assert.deepEqual(request.cookies, { reader_session_persistent: "secret" });
      }
    } finally {
      Date.now = originalNow;
    }
  });

  it("injects accepted cookies only into trusted HTTPS requests", async () => {
    const source = create();
    source.setCookie(cookie());

    const trusted = await source.interceptRequest({
      url: "https://api.reader.example/profile",
      method: "GET",
      headers: { "X-Paperback-Test-Cookie-Generation": "999" },
    });
    const untrusted = await source.interceptRequest({
      url: "https://cdn.example/page.webp",
      method: "GET",
      cookies: {
        reader_session: "caller-secret",
        cf_clearance: "source-only",
        display: "wide",
      },
    });

    assert.deepEqual(trusted.cookies, { reader_session: "secret" });
    assert.deepEqual(trusted.headers, { "x-paperback-test-cookie-generation": "0" });
    assert.deepEqual(untrusted.cookies, { display: "wide" });

    const malformedMap = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error("private malformed-cookie-map failure");
        },
      },
    ) as Record<string, string>;
    const malformed = await source.interceptRequest({
      url: "https://cdn.example/page.webp",
      method: "GET",
      cookies: malformedMap,
    });
    assert.equal("cookies" in malformed, false);
  });

  it("tolerates malformed cookie batches at runtime", async () => {
    const throwingCookie = new Proxy(cookie(), {
      get: () => {
        throw new Error("malformed cookie accessor");
      },
    });
    const throwingArray = new Proxy([cookie()], {
      get: (target, property, receiver) => {
        if (property === "0") throw new Error("malformed array member");
        return Reflect.get(target, property, receiver);
      },
    });
    secureState.set(STATE_KEY, [null, {}, throwingCookie]);
    const source = create({ maxCookieCount: 2, maxCookieBytes: 1_024 });
    source.setCookies(null as unknown as Cookie[]);
    source.setCookies([
      null as unknown as Cookie,
      {} as Cookie,
      throwingCookie,
      cookie({ name: "display_invalid", value: "value;injected=true" }),
      cookie({ name: "bad-path", path: "relative" }),
    ]);
    source.setCookies(throwingArray);
    await source.interceptResponse(
      { url: "https://reader.example/login", method: "GET" },
      {
        url: "https://reader.example/login",
        status: 200,
        headers: {},
        cookies: throwingArray,
      },
      new ArrayBuffer(0),
    );
    const throwingCookieCollection = {
      url: "https://reader.example/login",
      status: 200,
      headers: {},
      get cookies(): Cookie[] {
        throw new Error("malformed response cookie collection");
      },
    };
    await source.interceptResponse(
      { url: "https://reader.example/login", method: "GET" },
      throwingCookieCollection,
      new ArrayBuffer(0),
    );
    assert.deepEqual(source.cookies, []);
  });

  it("survives unavailable secure storage without exposing storage errors", () => {
    Object.assign(globalThis, {
      Application: {
        getSecureState: () => {
          throw new Error("stored cookie=private");
        },
        setSecureState: () => {
          throw new Error("stored cookie=private");
        },
      },
    });

    assert.doesNotThrow(() => create().setCookie(cookie()));
  });

  it("captures only cookies set by their trusted response origin", async () => {
    const source = create();
    const request = await source.interceptRequest({
      url: "https://reader.example/login",
      method: "GET",
    });

    await source.interceptResponse(
      request,
      {
        url: request.url,
        status: 200,
        headers: {},
        cookies: [cookie(), cookie({ name: "foreign", domain: "evil.example" })],
      } as Response,
      new ArrayBuffer(0),
    );

    assert.deepEqual(source.cookies, [cookie()]);
  });

  it("applies filtering, deletion, replacement, blocking, and bounds atomically in batches", () => {
    const source = create({ maxCookieCount: 2, maxCookieBytes: 1_024 });
    source.setCookies([
      {
        ...cookie({ name: "display_a", value: "a" }),
        unexpectedPersistedField: "must-be-dropped",
      } as Cookie,
      cookie({ name: "display_b", value: "b" }),
      cookie({ name: "display_c", value: "over-count" }),
      cookie({ name: "foreign", domain: "evil.example" }),
    ]);
    assert.deepEqual(
      source.cookies.map(({ name, value }) => [name, value]),
      [
        ["display_a", "a"],
        ["display_b", "b"],
      ],
    );
    assert.equal("unexpectedPersistedField" in (source.cookies[0] ?? {}), false);

    source.setCookies([
      cookie({ name: "display_a", expires: new Date(Date.now() - 1) }),
      cookie({ name: "display_b", value: "replacement" }),
      cookie({ name: "display_c", value: "now-fits" }),
    ]);
    assert.deepEqual(
      source.cookies.map(({ name, value }) => [name, value]),
      [
        ["display_b", "replacement"],
        ["display_c", "now-fits"],
      ],
    );

    source.invalidateSensitiveCookies();
    source.setCookies([
      cookie({ name: "reader_new", value: "blocked" }),
      cookie({ name: "display_b", value: "x".repeat(2_000) }),
    ]);
    assert.equal(
      source.cookies.some(({ name }) => name === "reader_new"),
      false,
    );
    assert.equal(source.cookies.find(({ name }) => name === "display_b")?.value, "replacement");
  });

  it("preserves distinct apex and www cookie identities during replacement", () => {
    const source = new SecureCookieInterceptor({
      stateKey: "domain-cookie-state",
      generationHeader: "x-test-cookie-generation",
      isTrustedRequestUrl: () => true,
      isAcceptedCookie: (candidate) => {
        const domain = candidate.domain.replace(/^\.+/, "");
        return domain === "reader.example" || domain === "www.reader.example";
      },
      isSensitiveCookieName: () => false,
      maxCookieCount: 8,
      maxCookieBytes: 4_096,
    });
    source.setCookies([
      cookie({ name: "session", value: "apex", domain: ".reader.example" }),
      cookie({ name: "session", value: "www", domain: "www.reader.example" }),
    ]);
    source.setCookie(
      cookie({ name: "session", value: "apex-replaced", domain: ".reader.example" }),
    );

    assert.deepEqual(
      source.cookies.map(({ domain, value }) => [domain, value]),
      [
        [".www.reader.example", "www"],
        [".reader.example", "apex-replaced"],
      ],
    );
  });

  it("prevents stale responses from resurrecting invalidated sessions", async () => {
    const source = create();
    source.setCookie(cookie({ value: "old" }));
    const staleRequest = await source.interceptRequest({
      url: "https://reader.example/profile",
      method: "GET",
    });

    source.invalidateSensitiveCookies();
    source.acceptSensitiveCookies();
    source.setCookie(cookie({ value: "new" }));
    await source.interceptResponse(
      staleRequest,
      {
        url: staleRequest.url,
        status: 200,
        headers: {},
        cookies: [cookie({ value: "old-again" })],
      },
      new ArrayBuffer(0),
    );

    assert.deepEqual(source.cookies, [cookie({ value: "new" })]);
  });

  it("binds injected cookies to the generation captured before its async boundary", async () => {
    const source = create();
    source.setCookie(cookie({ value: "old" }));
    const pendingRequest = source.interceptRequest({
      url: "https://reader.example/profile",
      method: "GET",
    });

    source.invalidateSensitiveCookies();
    source.acceptSensitiveCookies();
    source.setCookie(cookie({ value: "new" }));
    const staleRequest = await pendingRequest;

    assert.deepEqual(staleRequest.cookies, { reader_session: "old" });
    assert.equal(staleRequest.headers?.["x-paperback-test-cookie-generation"], "0");
    await source.interceptResponse(
      staleRequest,
      {
        url: staleRequest.url,
        status: 200,
        headers: {},
        cookies: [cookie({ value: "old-again" })],
      },
      new ArrayBuffer(0),
    );
    assert.deepEqual(source.cookies, [cookie({ value: "new" })]);
  });

  it("rejects missing and noncanonical response generation markers", async () => {
    for (const headers of [undefined, { "x-paperback-test-cookie-generation": "00" }]) {
      const source = create();
      source.setCookie(cookie({ value: "current" }));
      await source.interceptResponse(
        {
          url: "https://reader.example/profile",
          method: "GET",
          ...(headers && { headers }),
        },
        {
          url: "https://reader.example/profile",
          status: 200,
          headers: {},
          cookies: [cookie({ value: "forged" })],
        },
        new ArrayBuffer(0),
      );
      assert.equal(source.cookies.find(({ name }) => name === "reader_session")?.value, "current");
    }
  });

  it("clears sensitive auth while retaining source-scoped challenge cookies", () => {
    const source = create();
    source.setCookie(cookie());
    source.setCookie(cookie({ name: "cf_clearance", value: "clear" }));

    source.invalidateSensitiveCookies();

    assert.deepEqual(source.cookies, [cookie({ name: "cf_clearance", value: "clear" })]);
  });

  it("bounds restored and response cookies by count and aggregate bytes", async () => {
    secureState.set(
      STATE_KEY,
      Array.from({ length: 20 }, (_, index) =>
        cookie({ name: `reader_${index}`, value: `value-${index}` }),
      ),
    );
    const source = create({ maxCookieCount: 2, maxCookieBytes: 1_024 });
    assert.deepEqual(
      source.cookies.map(({ name }) => name),
      ["reader_0", "reader_1"],
    );
    assert.equal((secureState.get(STATE_KEY) as Cookie[]).length, 2);

    const request: Request = { url: "https://reader.example/login", method: "GET" };
    await source.interceptResponse(
      request,
      {
        url: request.url,
        status: 200,
        headers: {},
        cookies: [
          cookie({ name: "reader_2" }),
          cookie({ name: "reader_3" }),
          cookie({ name: "reader_4" }),
        ],
      },
      new ArrayBuffer(0),
    );
    assert.deepEqual(
      source.cookies.map(({ name }) => name),
      ["reader_0", "reader_1"],
    );

    source.setCookie(cookie({ name: "reader_0", value: "x".repeat(2_000) }));
    assert.equal(source.cookies.find(({ name }) => name === "reader_0")?.value, "value-0");
  });
});
