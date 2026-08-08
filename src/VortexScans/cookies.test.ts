import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { Cookie, Request, Response } from "@paperback/types";

import { VORTEX_COOKIE_STATE_KEY, VortexCookieInterceptor } from "./cookies.js";
import { VortexInterceptor } from "./interceptor.js";

const originalApplication = globalThis.Application;
const originalURL = globalThis.URL;

const sessionCookie = (overrides: Partial<Cookie> = {}): Cookie => ({
  name: "__Secure-vthemeauth.session_token",
  value: "token",
  domain: ".vortexscans.org",
  path: "/",
  ...overrides,
});

let secureState = new Map<string, unknown>();

beforeEach(() => {
  secureState = new Map();
  Object.assign(globalThis, {
    Application: {
      getSecureState: (key: string) => secureState.get(key),
      setSecureState: (value: unknown, key: string) => secureState.set(key, value),
      getDefaultUserAgent: async () => "Paperback Test/0.9",
    },
  });
});

afterEach(() => {
  Object.assign(globalThis, { Application: originalApplication, URL: originalURL });
});

describe("VortexCookieInterceptor", () => {
  it("persists even session cookies in source-scoped secure state", () => {
    const first = new VortexCookieInterceptor();
    first.setCookie(sessionCookie());

    assert.deepEqual(secureState.get(VORTEX_COOKIE_STATE_KEY), [sessionCookie()]);

    const restored = new VortexCookieInterceptor();
    assert.deepEqual(restored.cookies, [sessionCookie()]);
  });

  it("rejects third-party and expired cookies when setting and restoring", () => {
    secureState.set(VORTEX_COOKIE_STATE_KEY, [
      sessionCookie(),
      sessionCookie({ name: "third_party", domain: "google.com" }),
      sessionCookie({ name: "www_cookie", domain: "www.vortexscans.org" }),
      sessionCookie({ name: "expired", expires: new Date(Date.now() - 1) }),
    ]);

    const interceptor = new VortexCookieInterceptor();
    interceptor.setCookie(sessionCookie({ name: "another", domain: "example.com" }));

    assert.deepEqual(interceptor.cookies, [sessionCookie()]);
  });

  it("rehydrates serialized secure-state expiry dates", () => {
    const expires = new Date(Date.now() + 60_000);
    secureState.set(VORTEX_COOKIE_STATE_KEY, [
      { ...sessionCookie(), expires: expires.toISOString() },
    ]);

    const interceptor = new VortexCookieInterceptor();

    assert.ok(interceptor.cookies[0]?.expires instanceof Date);
    assert.equal(interceptor.cookies[0]?.expires?.toISOString(), expires.toISOString());
  });

  it("injects a matching API session without leaking it to unrelated hosts", async () => {
    const interceptor = new VortexCookieInterceptor();
    interceptor.setCookie(sessionCookie());

    const apiRequest = await interceptor.interceptRequest({
      url: "https://api.vortexscans.org/api/me",
      method: "GET",
    });
    const otherRequest = await interceptor.interceptRequest({
      url: "https://example.com/",
      method: "GET",
    });
    const insecureRequest = await interceptor.interceptRequest({
      url: "http://api.vortexscans.org/api/me",
      method: "GET",
    });
    const storageRequest = await interceptor.interceptRequest({
      url: "https://storage.vortexscans.org/page.webp",
      method: "GET",
    });

    assert.deepEqual(apiRequest.cookies, { "__Secure-vthemeauth.session_token": "token" });
    assert.deepEqual(otherRequest.cookies, {});
    assert.deepEqual(insecureRequest.cookies, {});
    assert.deepEqual(storageRequest.cookies, {});
  });

  it("injects sessions when Paperback provides no browser URL global", async () => {
    Object.assign(globalThis, { URL: undefined });
    const interceptor = new VortexCookieInterceptor();
    interceptor.setCookie(sessionCookie());

    const request = await interceptor.interceptRequest({
      url: "https://api.vortexscans.org/api/me",
      method: "GET",
    });

    assert.deepEqual(request.cookies, { "__Secure-vthemeauth.session_token": "token" });
  });

  it("captures response cookies securely and deletion is persisted", async () => {
    const interceptor = new VortexCookieInterceptor();
    const cookie = sessionCookie({ expires: new Date(Date.now() + 60_000) });
    const response = {
      status: 200,
      headers: {},
      cookies: [cookie, sessionCookie({ name: "foreign", domain: "example.com" })],
    } as Response;

    await interceptor.interceptResponse(
      { url: "https://api.vortexscans.org/api/me", method: "GET" } as Request,
      response,
      new ArrayBuffer(0),
    );
    assert.deepEqual(interceptor.cookies, [cookie]);

    interceptor.deleteCookie(cookie);
    assert.deepEqual(interceptor.cookies, []);
    assert.deepEqual(secureState.get(VORTEX_COOKIE_STATE_KEY), []);
  });

  it("rejects a forged Vortex cookie from a non-Vortex response", async () => {
    const interceptor = new VortexCookieInterceptor();
    const forged = sessionCookie();

    await interceptor.interceptResponse(
      { url: "https://evil.example/resource", method: "GET" },
      {
        url: "https://evil.example/resource",
        status: 200,
        headers: {},
        cookies: [forged],
      },
      new ArrayBuffer(0),
    );

    assert.deepEqual(interceptor.cookies, []);
    assert.deepEqual(secureState.get(VORTEX_COOKIE_STATE_KEY), []);
  });

  it("rejects cookies from HTTP and non-session Vortex subdomains", async () => {
    const interceptor = new VortexCookieInterceptor();
    const forged = sessionCookie();

    for (const url of [
      "http://api.vortexscans.org/api/me",
      "https://storage.vortexscans.org/page.webp",
    ]) {
      await interceptor.interceptResponse(
        { url, method: "GET" },
        { url, status: 200, headers: {}, cookies: [forged] },
        new ArrayBuffer(0),
      );
    }

    assert.deepEqual(interceptor.cookies, []);
  });

  it("does not let stale responses restore invalidated authentication", async () => {
    const interceptor = new VortexCookieInterceptor();
    interceptor.setCookie(sessionCookie({ value: "old-session" }));
    const staleRequest = await interceptor.interceptRequest({
      url: "https://api.vortexscans.org/api/me",
      method: "GET",
    });

    interceptor.invalidateAuthCookies();
    interceptor.acceptAuthCookies();
    interceptor.setCookie(sessionCookie({ value: "new-session" }));
    await interceptor.interceptResponse(
      staleRequest,
      {
        url: staleRequest.url,
        status: 200,
        headers: {},
        cookies: [sessionCookie({ value: "old-session-restored" })],
      },
      new ArrayBuffer(0),
    );

    assert.deepEqual(interceptor.cookies, [sessionCookie({ value: "new-session" })]);

    interceptor.invalidateAuthCookies();
    const logoutRequest = await interceptor.interceptRequest({
      url: "https://api.vortexscans.org/api/auth/sign-out",
      method: "POST",
    });
    await interceptor.interceptResponse(
      logoutRequest,
      {
        url: logoutRequest.url,
        status: 200,
        headers: {},
        cookies: [sessionCookie({ value: "late-session" })],
      },
      new ArrayBuffer(0),
    );
    assert.deepEqual(interceptor.cookies, []);
  });

  it("preserves the auth generation through Paperback's registered interceptor pipeline", async () => {
    const cookies = new VortexCookieInterceptor();
    const headers = new VortexInterceptor();
    cookies.invalidateAuthCookies();
    cookies.acceptAuthCookies();
    cookies.setCookie(sessionCookie({ value: "current-session" }));
    const originalRequest: Request = {
      url: "https://api.vortexscans.org/api/me",
      method: "GET",
    };

    // Paperback currently calls every request interceptor with the original
    // object, then uses only the final interceptor's return value.
    await cookies.interceptRequest(originalRequest);
    const finalRequest = await headers.interceptRequest(originalRequest);
    assert.deepEqual(finalRequest.cookies, {
      "__Secure-vthemeauth.session_token": "current-session",
    });
    await cookies.interceptResponse(
      finalRequest,
      {
        url: finalRequest.url,
        status: 200,
        headers: {},
        cookies: [sessionCookie({ value: "rotated-session" })],
      },
      new ArrayBuffer(0),
    );

    assert.deepEqual(cookies.cookies, [sessionCookie({ value: "rotated-session" })]);
  });

  it("removes caller-supplied auth cookies before later interceptors see an untrusted host", async () => {
    const cookies = new VortexCookieInterceptor();
    const headers = new VortexInterceptor();
    const originalRequest: Request = {
      url: "https://storage.vortexscans.org/page.webp",
      method: "GET",
      cookies: {
        "__Secure-vthemeauth.session_token": "must-not-leak",
        image_preference: "webp",
      },
    };

    await cookies.interceptRequest(originalRequest);
    const finalRequest = await headers.interceptRequest(originalRequest);

    assert.deepEqual(finalRequest.cookies, { image_preference: "webp" });
  });
});
