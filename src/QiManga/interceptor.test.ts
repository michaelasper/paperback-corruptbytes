import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { Request, Response } from "@paperback/types";

import { CloudflareError } from "../shared/http.js";
import { QiMangaCookieInterceptor } from "./cookies.js";
import { QiMangaInterceptor } from "./interceptor.js";

const originalApplication = globalThis.Application;
let secureState = new Map<string, unknown>();

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

describe("Qi Manga transport headers", () => {
  it("adds browser headers only on the explicit site and API origins", async () => {
    const interceptor = new QiMangaInterceptor();
    const api = await interceptor.interceptRequest({
      url: "https://api.qimanga.com/api/v1/home",
      method: "GET",
    });
    const login = await interceptor.interceptRequest({
      url: "https://qimanga.com/login",
      method: "GET",
    });
    const image = await interceptor.interceptRequest({
      url: "https://media.qimanga.com/pages/01.webp",
      method: "GET",
      headers: { authorization: "Bearer should-not-leak" },
    });
    const takeover = await interceptor.interceptRequest({
      url: "https://takeover.qimanga.com/private",
      method: "GET",
    });

    for (const request of [api, login]) {
      assert.equal(request.headers?.referer, "https://qimanga.com/");
      assert.equal(request.headers?.origin, "https://qimanga.com");
      assert.equal(request.headers?.["accept-language"], "en-US,en;q=0.9");
      assert.equal(request.headers?.["user-agent"], "Paperback/Test");
    }
    assert.equal(image.headers?.referer, undefined);
    assert.equal(image.headers?.origin, undefined);
    assert.equal(image.headers?.authorization, undefined);
    assert.equal(image.headers?.["user-agent"], "Paperback/Test");
    assert.equal(takeover.headers?.referer, undefined);
    assert.equal(takeover.headers?.origin, undefined);
  });

  it("rejects cross-origin redirects between credential-bearing first-party hosts", async () => {
    const interceptor = new QiMangaInterceptor();
    const redirectedResponse: Response = {
      url: "https://api.qimanga.com/api/v1/home",
      status: 302,
      headers: {},
      cookies: [],
    };
    const crossOrigin: Request = {
      url: "https://qimanga.com/login",
      method: "GET",
      headers: { authorization: "Bearer secret" },
      cookies: { accessToken: "secret" },
    };
    assert.equal(await interceptor.interceptRedirect(crossOrigin, redirectedResponse), undefined);
    assert.equal(
      await interceptor.interceptRedirect(
        { url: "https://qimanga.com/login", method: "GET" },
        { ...redirectedResponse, url: "https://media.qimanga.com/redirect" },
      ),
      undefined,
    );

    const sameOrigin: Request = {
      url: "https://api.qimanga.com/api/v1/series",
      method: "GET",
    };
    assert.deepEqual(
      await interceptor.interceptRedirect(sameOrigin, redirectedResponse),
      sameOrigin,
    );
  });

  it("raises Cloudflare only for verified first-party challenge bodies", async () => {
    const interceptor = new QiMangaInterceptor();
    const request: Request = { url: "https://api.qimanga.com/api/v1/home", method: "GET" };
    const response: Response = {
      url: request.url,
      status: 403,
      headers: { "content-type": "text/html" },
      cookies: [],
    };
    const body = new TextEncoder().encode("<html><title>Just a moment</title></html>").buffer;

    await assert.rejects(interceptor.interceptResponse(request, response, body), CloudflareError);
    assert.equal(
      await interceptor.interceptResponse(
        { url: "https://media.qimanga.com/page.webp", method: "GET" },
        { ...response, url: "https://media.qimanga.com/page.webp" },
        body,
      ),
      body,
    );
  });
});

describe("Qi Manga cookie state machine", () => {
  it("sends first-party auth cookies only to the site and API", async () => {
    const cookies = new QiMangaCookieInterceptor();
    cookies.setCookie({ name: "accessToken", value: "secret", domain: ".qimanga.com", path: "/" });
    cookies.setCookie({ name: "cf_clearance", value: "clear", domain: ".qimanga.com", path: "/" });
    cookies.setCookie({ name: "foreign", value: "no", domain: "example.com", path: "/" });

    const api = await cookies.interceptRequest({
      url: "https://api.qimanga.com/api/v1/home",
      method: "GET",
    });
    const site = await cookies.interceptRequest({ url: "https://qimanga.com/", method: "GET" });
    const image = await cookies.interceptRequest({
      url: "https://media.qimanga.com/page.webp",
      method: "GET",
      cookies: { accessToken: "caller", display: "wide" },
    });
    const fallback = await cookies.interceptRequest({
      url: "https://qimanga.com/qiscans.ico",
      method: "GET",
    });
    const takeover = await cookies.interceptRequest({
      url: "https://takeover.qimanga.com/page.webp",
      method: "GET",
      cookies: { accessToken: "caller", display: "wide" },
    });

    assert.deepEqual(api.cookies, { accessToken: "secret", cf_clearance: "clear" });
    assert.deepEqual(site.cookies, { accessToken: "secret", cf_clearance: "clear" });
    assert.deepEqual(image.cookies, {});
    assert.deepEqual(fallback.cookies, {});
    assert.deepEqual(takeover.cookies, {});
  });

  it("rejects forged cookies from neutral and unlisted response origins", async () => {
    const cookies = new QiMangaCookieInterceptor();
    const data = new ArrayBuffer(0);
    for (const url of [
      "https://media.qimanga.com/page.webp",
      "https://takeover.qimanga.com/page.webp",
    ]) {
      await cookies.interceptResponse(
        { url, method: "GET" },
        {
          url,
          status: 200,
          headers: {},
          cookies: [{ name: "accessToken", value: "forged", domain: ".qimanga.com", path: "/" }],
        },
        data,
      );
    }
    assert.equal(
      cookies.cookies.some((cookie) => cookie.value === "forged"),
      false,
    );
  });

  it("cannot resurrect a logged-out session from a stale in-flight response", async () => {
    const cookies = new QiMangaCookieInterceptor();
    const oldRequest = await cookies.interceptRequest({
      url: "https://api.qimanga.com/api/v1/users/me",
      method: "GET",
    });
    cookies.invalidateAuthCookies();

    await cookies.interceptResponse(
      oldRequest,
      {
        url: oldRequest.url,
        status: 200,
        headers: {},
        cookies: [{ name: "accessToken", value: "stale", domain: ".qimanga.com", path: "/" }],
      },
      new ArrayBuffer(0),
    );
    assert.equal(
      cookies.cookies.some((cookie) => cookie.value === "stale"),
      false,
    );

    cookies.acceptAuthCookies();
    const newRequest = await cookies.interceptRequest({
      url: "https://api.qimanga.com/api/v1/users/me",
      method: "GET",
    });
    await cookies.interceptResponse(
      newRequest,
      {
        url: newRequest.url,
        status: 200,
        headers: {},
        cookies: [{ name: "accessToken", value: "fresh", domain: ".qimanga.com", path: "/" }],
      },
      new ArrayBuffer(0),
    );
    assert.equal(
      cookies.cookies.some((cookie) => cookie.value === "fresh"),
      true,
    );
  });
});
