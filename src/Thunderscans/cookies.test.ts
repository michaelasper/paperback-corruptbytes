import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { Cookie } from "@paperback/types";

import { THUNDER_COOKIE_STATE_KEY, ThunderCookieInterceptor } from "./cookies.js";

/**
 * Paperback's cookie getter materialises an absent expiry as its own
 * `expires: undefined` key; assertions compare the declared cookie fields.
 */
const observed = (cookies: readonly Cookie[]): Cookie[] =>
  cookies.map(({ expires, ...rest }) => (expires === undefined ? rest : { ...rest, expires }));

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

    assert.deepEqual(observed((secureState.get(THUNDER_COOKIE_STATE_KEY) as Cookie[]) ?? []), [
      cookie(),
    ]);
    assert.deepEqual(observed(restored.cookies), [cookie()]);
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

    assert.deepEqual(observed(source.cookies), [cookie({ name: "cf_clearance", value: "clear" })]);
  });
});
