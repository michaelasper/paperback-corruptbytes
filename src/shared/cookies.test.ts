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

const create = (): SecureCookieInterceptor =>
  new SecureCookieInterceptor({
    stateKey: STATE_KEY,
    generationHeader: "x-paperback-test-cookie-generation",
    isTrustedRequestUrl: (url) => /^https:\/\/(?:api\.)?reader\.example\//.test(url),
    isAcceptedCookie,
    isSensitiveCookieName,
    shouldStripCookieName: (name) => isSensitiveCookieName(name) || name === "cf_clearance",
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
  it("persists session cookies and restores serialized dates", () => {
    const expires = new Date(Date.now() + 60_000);
    const first = create();
    first.setCookie(cookie({ expires }));

    const stored = secureState.get(STATE_KEY);
    assert.deepEqual(stored, [cookie({ expires })]);

    secureState.set(STATE_KEY, [{ ...cookie(), expires: expires.toISOString() }]);
    const restored = create();
    assert.ok(restored.cookies[0]?.expires instanceof Date);
    assert.equal(restored.cookies[0]?.expires?.toISOString(), expires.toISOString());
  });

  it("injects accepted cookies only into trusted HTTPS requests", async () => {
    const source = create();
    source.setCookie(cookie());

    const trusted = await source.interceptRequest({
      url: "https://api.reader.example/profile",
      method: "GET",
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
    assert.deepEqual(untrusted.cookies, { display: "wide" });
  });

  it("captures only cookies set by their trusted response origin", async () => {
    const source = create();
    const request: Request = { url: "https://reader.example/login", method: "GET" };

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

  it("clears sensitive auth while retaining source-scoped challenge cookies", () => {
    const source = create();
    source.setCookie(cookie());
    source.setCookie(cookie({ name: "cf_clearance", value: "clear" }));

    source.invalidateSensitiveCookies();

    assert.deepEqual(source.cookies, [cookie({ name: "cf_clearance", value: "clear" })]);
  });
});
