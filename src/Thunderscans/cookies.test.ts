import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { Cookie } from "@paperback/types";

import { THUNDER_COOKIE_STATE_KEY, ThunderCookieInterceptor } from "./cookies.js";

const originalApplication = globalThis.Application;
let secureState = new Map<string, unknown>();

const cookie = (overrides: Partial<Cookie> = {}): Cookie => ({
  name: "PHPSESSID",
  value: "session",
  domain: "en-thunderscans.com",
  path: "/",
  ...overrides,
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

describe("ThunderCookieInterceptor", () => {
  it("persists session cookies in source-specific secure state", () => {
    const first = new ThunderCookieInterceptor();
    first.setCookie(cookie());
    const restored = new ThunderCookieInterceptor();

    assert.deepEqual(secureState.get(THUNDER_COOKIE_STATE_KEY), [cookie()]);
    assert.deepEqual(restored.cookies, [cookie()]);
  });

  it("injects cookies only into the exact source host", async () => {
    const source = new ThunderCookieInterceptor();
    source.setCookie(cookie());

    const firstParty = await source.interceptRequest({
      url: "https://en-thunderscans.com/profile/",
      method: "GET",
    });
    const external = await source.interceptRequest({
      url: "https://cdn.example/page.webp",
      method: "GET",
      cookies: {
        PHPSESSID: "must-not-leak",
        cf_clearance: "source-only",
        _cfuvid: "source-fingerprint",
        image: "webp",
      },
    });

    assert.deepEqual(firstParty.cookies, { PHPSESSID: "session" });
    assert.deepEqual(external.cookies, { image: "webp" });
  });

  it("invalidates auth without discarding Cloudflare clearance", () => {
    const source = new ThunderCookieInterceptor();
    source.setCookie(cookie());
    source.setCookie(cookie({ name: "cf_clearance", value: "clear" }));

    source.invalidateAuthCookies();

    assert.deepEqual(source.cookies, [cookie({ name: "cf_clearance", value: "clear" })]);
  });
});
