import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { Request } from "@paperback/types";

import {
  AtsumaruCookieInterceptor,
  isAtsumaruCloudflareCookieName,
  isAtsumaruCookie,
} from "./cookies.js";

const originalApplication = globalThis.Application;
let secureState = new Map<string, unknown>();

beforeEach(() => {
  secureState = new Map();
  Object.assign(globalThis, {
    Application: {
      getSecureState: (key: string) => secureState.get(key),
      setSecureState: (value: unknown, key: string) => secureState.set(key, value),
    },
  });
});

afterEach(() => Object.assign(globalThis, { Application: originalApplication }));

describe("Atsumaru secure cookies", () => {
  it("recognizes only Cloudflare cookies at first-party domains", () => {
    assert.equal(isAtsumaruCloudflareCookieName("cf_clearance"), true);
    assert.equal(isAtsumaruCloudflareCookieName("__cf_bm"), true);
    assert.equal(isAtsumaruCloudflareCookieName("session"), false);
    assert.equal(isAtsumaruCookie({ name: "cf_clearance", value: "x", domain: ".atsu.moe" }), true);
    assert.equal(
      isAtsumaruCookie({ name: "cf_clearance", value: "x", domain: ".cdn.atsu.moe" }),
      false,
    );
    assert.equal(isAtsumaruCookie({ name: "session", value: "x", domain: ".atsu.moe" }), false);
  });

  it("persists only source-scoped CF cookies and strips them from CDN requests", async () => {
    const cookies = new AtsumaruCookieInterceptor();
    cookies.setCookie({ name: "cf_clearance", value: "ok", domain: ".atsu.moe", path: "/" });
    cookies.setCookie({ name: "session", value: "no", domain: ".atsu.moe", path: "/" });
    cookies.setCookie({ name: "cf_bad", value: "no", domain: ".cdn.atsu.moe", path: "/" });

    const site = await cookies.interceptRequest({ url: "https://atsu.moe/", method: "GET" });
    const cdn = await cookies.interceptRequest({
      url: "https://cdn.atsu.moe/pages/1.jpg",
      method: "GET",
      cookies: { cf_clearance: "caller", display: "wide" },
    });
    assert.deepEqual(site.cookies, { cf_clearance: "ok" });
    assert.equal(site.headers?.["x-paperback-atsumaru-cookie-generation"], "0");
    assert.deepEqual(cdn.cookies, { display: "wide" });
    assert.equal(cdn.headers?.["x-paperback-atsumaru-cookie-generation"], undefined);
    assert.deepEqual(secureState.get("atsumaru.secure_cookies"), [
      { name: "cf_clearance", value: "ok", domain: ".atsu.moe", path: "/" },
    ]);
  });

  it("never accepts cookies from CDN or attacker origins", async () => {
    const cookies = new AtsumaruCookieInterceptor();
    const data = new TextEncoder().encode("ok").buffer;
    await cookies.interceptResponse(
      { url: "https://cdn.atsu.moe/page.jpg", method: "GET" },
      {
        url: "https://cdn.atsu.moe/page.jpg",
        status: 200,
        headers: {},
        cookies: [{ name: "cf_clearance", value: "cdn", domain: ".atsu.moe" }],
      },
      data,
    );
    await cookies.interceptResponse(
      { url: "https://atsu.moe/", method: "GET" },
      {
        url: "https://evil.example/",
        status: 200,
        headers: {},
        cookies: [{ name: "cf_clearance", value: "evil", domain: ".atsu.moe" }],
      },
      data,
    );
    assert.deepEqual(secureState.get("atsumaru.secure_cookies"), []);
  });

  it("filters CDN cookies in place for Paperback's interceptor pipeline", async () => {
    const cookies = new AtsumaruCookieInterceptor();
    const request: Request = {
      url: "https://cdn.atsu.moe/image.jpg",
      method: "GET",
      cookies: { cf_clearance: "x", other: "y" },
    };
    const intercepted = await cookies.interceptRequest(request);
    assert.deepEqual(intercepted.cookies, { other: "y" });
  });
});
