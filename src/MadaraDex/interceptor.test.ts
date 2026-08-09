import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { Cookie, Request, Response } from "@paperback/types";

import { DEFAULT_MAX_RESPONSE_BYTES } from "../shared/http.js";
import { MdxAuthManager, type MdxAuthContract } from "./auth.js";
import { MadaraDexCookieInterceptor } from "./cookies.js";
import { CDN_RETRY_HEADER, MadaraDexInterceptor } from "./interceptor.js";

const originalApplication = globalThis.Application;
let secureState: Map<string, unknown>;

const authCookie = (name: string, value: string): Cookie => ({
  name,
  value,
  domain: ".madaradex.org",
  path: "/",
  expires: new Date(Date.now() + 60_000),
});

class FakeAuth implements MdxAuthContract {
  ensures = 0;
  refreshes = 0;

  async ensureAuthenticated(): Promise<void> {
    this.ensures += 1;
  }

  async refresh(_force?: boolean): Promise<void> {
    this.refreshes += 1;
  }

  isAuthenticated(): boolean {
    return true;
  }
}

beforeEach(() => {
  secureState = new Map();
  Object.assign(globalThis, {
    Application: {
      getDefaultUserAgent: async () => "Paperback/Test",
      getSecureState: (key: string) => secureState.get(key),
      setSecureState: (value: unknown, key: string) => secureState.set(key, value),
    },
  });
});

afterEach(() => Object.assign(globalThis, { Application: originalApplication }));

describe("MadaraDex transport boundaries", () => {
  it("preserves auth cookies and required CDN headers through Paperback's interceptor pipeline", async () => {
    const store = new MadaraDexCookieInterceptor();
    store.setCookie(authCookie("mdx_fp", "fingerprint"));
    store.setCookie(authCookie("mdx_auth", "auth"));
    const interceptor = new MadaraDexInterceptor(new MdxAuthManager(store));
    const original: Request = {
      url: "https://cdn.madaradex.org/manga/page.webp",
      method: "GET",
    };

    // Paperback currently invokes each request interceptor with this same
    // object and keeps only the final interceptor's return value.
    await interceptor.interceptRequest(original);
    const finalRequest = await store.interceptRequest(original);

    assert.equal(finalRequest.headers?.referer, "https://madaradex.org/");
    assert.equal(finalRequest.headers?.["sec-fetch-site"], "same-site");
    assert.deepEqual(finalRequest.cookies, { mdx_fp: "fingerprint", mdx_auth: "auth" });
  });

  it("persists only source-scoped auth/Cloudflare cookies and forwards them to the image CDN", async () => {
    const store = new MadaraDexCookieInterceptor();
    store.setCookie(authCookie("mdx_fp", "fingerprint"));
    store.setCookie(authCookie("mdx_auth", "auth"));
    store.setCookie(authCookie("cf_clearance", "clear"));
    store.setCookie(authCookie("wordpress_logged_in", "reject"));

    const site = await store.interceptRequest({
      url: "https://madaradex.org/title/",
      method: "GET",
    });
    const cdn = await store.interceptRequest({
      url: "https://cdn.madaradex.org/manga/page.webp",
      method: "GET",
    });
    const foreign = await store.interceptRequest({
      url: "https://images.example/page.webp",
      method: "GET",
      cookies: { mdx_auth: "caller", display: "wide" },
    });
    const unlistedSubdomain = await store.interceptRequest({
      url: "https://takeover.madaradex.org/page.webp",
      method: "GET",
    });

    assert.deepEqual(site.cookies, {
      mdx_fp: "fingerprint",
      mdx_auth: "auth",
      cf_clearance: "clear",
    });
    assert.deepEqual(cdn.cookies, site.cookies);
    assert.deepEqual(foreign.cookies, { display: "wide" });
    assert.deepEqual(unlistedSubdomain.cookies, {});
  });

  it("does not let an older response resurrect the auth token replaced by a forced refresh", async () => {
    const store = new MadaraDexCookieInterceptor();
    store.setCookie(authCookie("mdx_fp", "fingerprint"));
    store.setCookie(authCookie("mdx_auth", "old-auth"));
    const staleRequest = await store.interceptRequest({
      url: "https://madaradex.org/title/",
      method: "GET",
    });
    Object.assign(globalThis.Application, {
      scheduleRequest: async (request: Request): Promise<[Response, ArrayBuffer]> => [
        {
          url: request.url,
          status: 200,
          headers: {},
          cookies: [authCookie("mdx_auth", "fresh-auth")],
        },
        new ArrayBuffer(0),
      ],
    });
    await new MdxAuthManager(store).refresh(true);

    await store.interceptResponse(
      staleRequest,
      {
        url: staleRequest.url,
        status: 200,
        headers: {},
        cookies: [authCookie("mdx_auth", "stale-auth")],
      },
      new ArrayBuffer(0),
    );
    assert.equal(store.cookies.find((cookie) => cookie.name === "mdx_auth")?.value, "fresh-auth");
  });

  it("refreshes before first-party requests but bypasses recursion for the internal refresh", async () => {
    const auth = new FakeAuth();
    const interceptor = new MadaraDexInterceptor(auth);
    const normal = await interceptor.interceptRequest({
      url: "https://madaradex.org/title/",
      method: "GET",
    });
    const internal = await interceptor.interceptRequest({
      url: "https://madaradex.org/wp-admin/admin-ajax.php",
      method: "POST",
      headers: { "X-Mdx-Auth-Refresh": "1" },
    });
    const foreign = await interceptor.interceptRequest({
      url: "https://images.example/page.webp",
      method: "GET",
    });
    const unlistedSubdomain = await interceptor.interceptRequest({
      url: "https://takeover.madaradex.org/page.webp",
      method: "GET",
    });

    assert.equal(auth.ensures, 1);
    assert.equal(normal.headers?.referer, "https://madaradex.org/");
    assert.equal(normal.headers?.["sec-fetch-site"], "same-site");
    const cdn = await interceptor.interceptRequest({
      url: "https://cdn.madaradex.org/manga/page.webp",
      method: "GET",
    });
    assert.equal(cdn.headers?.referer, "https://madaradex.org/");
    assert.equal(cdn.headers?.["sec-fetch-site"], "same-site");
    assert.equal(internal.headers?.["X-Mdx-Auth-Refresh"], undefined);
    assert.equal(internal.headers?.["x-mdx-auth-refresh"], undefined);
    assert.equal(foreign.headers?.referer, undefined);
    assert.equal(unlistedSubdomain.headers?.referer, undefined);
    assert.equal(unlistedSubdomain.headers?.origin, undefined);
  });

  it("refreshes and retries a rejected CDN image exactly once", async () => {
    const auth = new FakeAuth();
    const interceptor = new MadaraDexInterceptor(auth);
    const scheduled: Request[] = [];
    Object.assign(globalThis.Application, {
      scheduleRequest: async (request: Request): Promise<[Response, ArrayBuffer]> => {
        scheduled.push(request);
        return [
          { url: request.url, status: 200, headers: { "content-type": "image/webp" }, cookies: [] },
          new TextEncoder().encode("retried-image").buffer,
        ];
      },
    });
    const request: Request = {
      url: "https://cdn.madaradex.org/manga/page.webp",
      method: "GET",
    };
    const response: Response = { url: request.url, status: 403, headers: {}, cookies: [] };
    const result = await interceptor.interceptResponse(request, response, new ArrayBuffer(0));

    assert.equal(auth.refreshes, 1);
    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0]?.headers?.[CDN_RETRY_HEADER], "1");
    assert.equal(response.status, 200);
    assert.equal(response.headers["content-type"], "image/webp");
    assert.equal(new TextDecoder().decode(result), "retried-image");

    const alreadyRetried = { ...request, headers: { [CDN_RETRY_HEADER]: "1" } };
    await assert.rejects(
      interceptor.interceptResponse(
        alreadyRetried,
        { url: request.url, status: 403, headers: {}, cookies: [] },
        new ArrayBuffer(0),
      ),
      /authorization failed after one retry/i,
    );
    assert.equal(scheduled.length, 1);
  });

  it("rejects a CDN retry that redirects away from the trusted CDN", async () => {
    const auth = new FakeAuth();
    const interceptor = new MadaraDexInterceptor(auth);
    Object.assign(globalThis.Application, {
      scheduleRequest: async (): Promise<[Response, ArrayBuffer]> => [
        {
          url: "https://evil.example/stolen.webp",
          status: 200,
          headers: { "content-type": "image/webp" },
          cookies: [],
        },
        new TextEncoder().encode("foreign-image").buffer,
      ],
    });
    const request: Request = {
      url: "https://cdn.madaradex.org/manga/page.webp",
      method: "GET",
    };
    const response: Response = { url: request.url, status: 403, headers: {}, cookies: [] };

    await assert.rejects(
      interceptor.interceptResponse(request, response, new ArrayBuffer(0)),
      /CDN response URL was not trusted/i,
    );
    assert.equal(auth.refreshes, 1);
    assert.equal(response.status, 403);
    assert.equal(response.url, request.url);
  });

  it("rejects an oversized CDN retry before handing bytes to Paperback", async () => {
    const auth = new FakeAuth();
    const interceptor = new MadaraDexInterceptor(auth);
    Object.assign(globalThis.Application, {
      scheduleRequest: async (request: Request): Promise<[Response, ArrayBuffer]> => [
        { url: request.url, status: 200, headers: {}, cookies: [] },
        new ArrayBuffer(DEFAULT_MAX_RESPONSE_BYTES + 1),
      ],
    });
    const request: Request = {
      url: "https://cdn.madaradex.org/manga/page.webp",
      method: "GET",
    };
    const response: Response = { url: request.url, status: 403, headers: {}, cookies: [] };

    await assert.rejects(
      interceptor.interceptResponse(request, response, new ArrayBuffer(0)),
      /MadaraDex CDN.*too large/i,
    );
    assert.equal(auth.refreshes, 1);
    assert.equal(response.status, 403);
  });
});
