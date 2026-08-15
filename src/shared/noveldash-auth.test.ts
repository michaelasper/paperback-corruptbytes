import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { Cookie, Request, Response } from "@paperback/types";

import {
  fetchNovelDashAccountStatus,
  isNovelDashAuthCookieName,
  isNovelDashCookie,
  NovelDashCookieInterceptor,
  replaceNovelDashCookies,
} from "./noveldash-auth.js";
import { NOVELDASH_TEST_SITE } from "./noveldash-test-fixtures.js";

const originalApplication = globalThis.Application;
let secureState = new Map<string, unknown>();

const cookie = (overrides: Partial<Cookie> = {}): Cookie => ({
  name: "__Secure-authjs.session-token",
  value: "secret",
  domain: ".fixture.example",
  path: "/",
  ...overrides,
});

beforeEach(() => {
  secureState = new Map();
  Object.assign(globalThis, {
    Application: {
      getSecureState: (key: string) => secureState.get(key),
      setSecureState: (value: unknown, key: string) => secureState.set(key, value),
      arrayBufferToUTF8String: (buffer: ArrayBuffer) => new TextDecoder().decode(buffer),
    },
  });
});

afterEach(() => {
  Object.assign(globalThis, { Application: originalApplication });
});

describe("NovelDash authentication", () => {
  it("scopes persisted cookies to the exact source domain", async () => {
    const interceptor = new NovelDashCookieInterceptor(NOVELDASH_TEST_SITE);
    interceptor.setCookie(cookie());
    interceptor.setCookie(cookie({ name: "foreign", domain: "evil.example" }));

    const firstParty = await interceptor.interceptRequest({
      url: "https://fixture.example/api/auth/session",
      method: "GET",
    });
    const media = await interceptor.interceptRequest({
      url: "https://media.fixture.example/page.webp",
      method: "GET",
    });
    assert.deepEqual(firstParty.cookies, { "__Secure-authjs.session-token": "secret" });
    assert.deepEqual(media.cookies, {});
  });

  it("recognizes Auth.js sessions and rejects deceptive domains", () => {
    assert.equal(isNovelDashAuthCookieName("__Host-authjs.csrf-token"), true);
    assert.equal(isNovelDashAuthCookieName("__Secure-authjs.session-token"), true);
    assert.equal(isNovelDashCookie(NOVELDASH_TEST_SITE, cookie()), true);
    assert.equal(
      isNovelDashCookie(NOVELDASH_TEST_SITE, cookie({ domain: "notfixture.example" })),
      false,
    );
  });

  it("replaces only saved authentication while retaining Cloudflare clearance", () => {
    const interceptor = new NovelDashCookieInterceptor(NOVELDASH_TEST_SITE);
    interceptor.setCookie(cookie({ value: "old" }));
    interceptor.setCookie(cookie({ name: "cf_clearance", value: "clearance" }));

    replaceNovelDashCookies(NOVELDASH_TEST_SITE, interceptor, [cookie({ value: "new" })]);
    assert.deepEqual(
      interceptor.cookies.map(({ name, value }) => [name, value]),
      [
        ["cf_clearance", "clearance"],
        ["__Secure-authjs.session-token", "new"],
      ],
    );
  });

  it("validates the current account through Auth.js session JSON", async () => {
    Object.assign(globalThis.Application, {
      scheduleRequest: async (request: Request): Promise<[Response, ArrayBuffer]> => [
        { url: request.url, status: 200, headers: {}, cookies: [] },
        new TextEncoder().encode(
          JSON.stringify({ user: { id: "reader", name: "Reader", email: "r@example.com" } }),
        ).buffer,
      ],
    });

    assert.deepEqual(await fetchNovelDashAccountStatus(NOVELDASH_TEST_SITE), {
      authenticated: true,
      displayName: "Reader",
      email: "r@example.com",
    });
  });

  it("clears stale authentication after a valid logged-out session response", async () => {
    const interceptor = new NovelDashCookieInterceptor(NOVELDASH_TEST_SITE);
    interceptor.setCookie(cookie());
    interceptor.setCookie(cookie({ name: "cf_clearance", value: "clear" }));
    Object.assign(globalThis.Application, {
      scheduleRequest: async (request: Request): Promise<[Response, ArrayBuffer]> => [
        { url: request.url, status: 200, headers: {}, cookies: [] },
        new TextEncoder().encode("{}").buffer,
      ],
    });

    assert.deepEqual(await fetchNovelDashAccountStatus(NOVELDASH_TEST_SITE, interceptor), {
      authenticated: false,
    });
    assert.deepEqual(
      interceptor.cookies.map((stored) => stored.name),
      ["cf_clearance"],
    );
  });
});
