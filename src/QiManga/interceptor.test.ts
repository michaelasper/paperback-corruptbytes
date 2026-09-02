import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { Request, Response } from "@paperback/types";

import { CloudflareError } from "../shared/http.js";
import {
  QIMANGA_COOKIE_GENERATION_HEADER,
  REFRESH_URL,
  refreshQiMangaSession,
  replaceQiMangaCookies,
  signOutQiManga,
} from "./auth.js";
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
      headers: {
        authorization: "Bearer should-not-leak",
        "x-api-key": "should-not-leak",
        range: "bytes=0-1023",
      },
      cookies: { accessToken: "should-not-leak" },
      body: "should-not-leak",
    });
    const fallback = await interceptor.interceptRequest({
      url: "https://qimanga.com/qiscans.ico?cache=1",
      method: "GET",
      headers: { authorization: "Bearer should-not-leak" },
    });
    const wwwFallback = await interceptor.interceptRequest({
      url: "https://www.qimanga.com/%71iscans.ico",
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
    assert.equal(image.headers?.["x-api-key"], undefined);
    assert.equal(image.headers?.range, "bytes=0-1023");
    assert.equal(image.headers?.["user-agent"], "Paperback/Test");
    assert.equal(image.cookies, undefined);
    assert.equal(image.body, undefined);
    assert.equal(fallback.headers?.referer, undefined);
    assert.equal(fallback.headers?.origin, undefined);
    assert.equal(fallback.headers?.authorization, undefined);
    assert.equal(fallback.headers?.["user-agent"], "Paperback/Test");
    assert.equal(wwwFallback.headers?.authorization, undefined);
    assert.equal(wwwFallback.headers?.referer, undefined);
    assert.equal(wwwFallback.headers?.origin, undefined);
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

    const neutralRedirect: Request = {
      url: "https://media.qiscans.org/pages/02.webp",
      method: "GET",
      headers: { authorization: "Bearer secret", referer: "https://private.example/" },
      cookies: { accessToken: "secret" },
    };
    assert.deepEqual(
      await interceptor.interceptRedirect(neutralRedirect, {
        ...redirectedResponse,
        url: "https://media.qimanga.com/pages/01.webp",
      }),
      { url: neutralRedirect.url, method: "GET", headers: {} },
    );
    assert.equal(
      await interceptor.interceptRedirect(
        { url: "https://evil.example/page.webp", method: "GET" },
        { ...redirectedResponse, url: "https://media.qimanga.com/pages/01.webp" },
      ),
      undefined,
    );
    assert.equal(
      await interceptor.interceptRedirect(
        { url: "https://media.qimanga.com/page.webp", method: "GET" },
        { ...redirectedResponse, url: "https://evil.example/redirect" },
      ),
      undefined,
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
  it("tracks account identity independently from same-account cookie refreshes", () => {
    const cookies = new QiMangaCookieInterceptor();
    assert.equal(cookies.authIdentityGeneration, 0);
    cookies.acceptAuthCookies();
    assert.equal(cookies.authIdentityGeneration, 0);
    cookies.markAuthenticationChanged();
    assert.equal(cookies.authIdentityGeneration, 1);
    cookies.invalidateAuthCookies();
    assert.equal(cookies.authIdentityGeneration, 2);
  });

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
      url: "https://qimanga.com/%71iscans.ico",
      method: "GET",
    });
    const wwwFallback = await cookies.interceptRequest({
      url: "https://www.qimanga.com/qiscans.ico",
      method: "GET",
    });
    const takeover = await cookies.interceptRequest({
      url: "https://takeover.qimanga.com/page.webp",
      method: "GET",
      cookies: { accessToken: "caller", display: "wide" },
    });
    const oversized = await cookies.interceptRequest({
      url: `https://api.qimanga.com/${"x".repeat(2_100)}`,
      method: "GET",
      cookies: { accessToken: "caller", display: "wide" },
    });

    assert.deepEqual(api.cookies, { accessToken: "secret", cf_clearance: "clear" });
    assert.deepEqual(site.cookies, { accessToken: "secret", cf_clearance: "clear" });
    for (const neutral of [image, fallback, wwwFallback, takeover, oversized]) {
      assert.equal("cookies" in neutral, false);
    }
  });

  it("selects duplicate API auth-cookie names by domain and path rather than jar order", async () => {
    const cookies = new QiMangaCookieInterceptor();
    cookies.setCookie({
      name: "refreshToken",
      value: "refresh-only",
      domain: "api.qimanga.com",
      path: "/api/v1/auth/refresh",
    });
    // Insert the broader duplicate last; Paperback's stock jar would otherwise win by order.
    cookies.setCookie({
      name: "refreshToken",
      value: "root",
      domain: ".qimanga.com",
      path: "/",
    });

    const refresh = await cookies.interceptRequest({ url: REFRESH_URL, method: "POST" });
    const catalog = await cookies.interceptRequest({
      url: "https://api.qimanga.com/api/v1/series",
      method: "GET",
      cookies: { refreshToken: "forged-caller" },
    });

    assert.deepEqual(refresh.cookies, { refreshToken: "refresh-only" });
    assert.deepEqual(catalog.cookies, { refreshToken: "root" });
  });

  it("never substitutes a newer session into a delayed old-generation request", async () => {
    const cookies = new QiMangaCookieInterceptor();
    cookies.setCookie({
      name: "accessToken",
      value: "account-a",
      domain: ".qimanga.com",
      path: "/",
    });
    const delayedRequest: Request = {
      url: "https://api.qimanga.com/api/v1/auth/logout",
      method: "POST",
      headers: { [QIMANGA_COOKIE_GENERATION_HEADER]: "0" },
      cookies: { accessToken: "account-a" },
    };

    cookies.invalidateAuthCookies();
    cookies.acceptAuthCookies();
    cookies.setCookie({
      name: "accessToken",
      value: "account-b",
      domain: ".qimanga.com",
      path: "/",
    });
    const intercepted = await cookies.interceptRequest(delayedRequest);

    assert.equal("cookies" in intercepted, false);
    assert.equal(intercepted.headers?.[QIMANGA_COOKIE_GENERATION_HEADER], "0");
    assert.equal(cookies.cookies.find(({ name }) => name === "accessToken")?.value, "account-b");
  });

  it("preserves captured credentials through Paperback's shared-object interceptor dispatch", async () => {
    const cookies = new QiMangaCookieInterceptor();
    const headers = new QiMangaInterceptor();
    cookies.setCookie({
      name: "accessToken",
      value: "account-a",
      domain: ".qimanga.com",
      path: "/",
    });
    const originalRequest: Request = {
      url: "https://api.qimanga.com/api/v1/users/me",
      method: "GET",
    };

    const pendingRequest = cookies.interceptRequest(originalRequest);
    cookies.invalidateAuthCookies();
    cookies.acceptAuthCookies();
    cookies.setCookie({
      name: "accessToken",
      value: "account-b",
      domain: ".qimanga.com",
      path: "/",
    });
    await pendingRequest; // Paperback discards this non-final interceptor result.
    const finalRequest = await headers.interceptRequest(originalRequest);

    assert.deepEqual(finalRequest.cookies, { accessToken: "account-a" });
    assert.equal(finalRequest.headers?.[QIMANGA_COOKIE_GENERATION_HEADER], "0");
    await cookies.interceptResponse(
      finalRequest,
      {
        url: finalRequest.url,
        status: 200,
        headers: {},
        cookies: [
          { name: "accessToken", value: "account-a-rotated", domain: ".qimanga.com", path: "/" },
        ],
      },
      new ArrayBuffer(0),
    );
    assert.equal(cookies.cookies.find(({ name }) => name === "accessToken")?.value, "account-b");
  });

  it("does not authenticate or accept cookies for malformed generation markers", async () => {
    const cookies = new QiMangaCookieInterceptor();
    cookies.setCookie({
      name: "accessToken",
      value: "account-a",
      domain: ".qimanga.com",
      path: "/",
    });
    const request = await cookies.interceptRequest({
      url: "https://api.qimanga.com/api/v1/users/me",
      method: "GET",
      headers: { [QIMANGA_COOKIE_GENERATION_HEADER]: "00" },
      cookies: { accessToken: "caller" },
    });
    assert.equal("cookies" in request, false);
    assert.equal(request.headers?.[QIMANGA_COOKIE_GENERATION_HEADER], "-1");

    await cookies.interceptResponse(
      request,
      {
        url: request.url,
        status: 200,
        headers: {},
        cookies: [
          { name: "accessToken", value: "must-not-persist", domain: ".qimanga.com", path: "/" },
        ],
      },
      new ArrayBuffer(0),
    );
    assert.equal(cookies.cookies.find(({ name }) => name === "accessToken")?.value, "account-a");
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

  it("rotates refresh cookies before advancing the stale-response generation", async () => {
    const cookies = new QiMangaCookieInterceptor();
    cookies.setCookie({
      name: "refreshToken",
      value: "old",
      domain: ".qimanga.com",
      path: "/",
    });
    const staleRequest = await cookies.interceptRequest({
      url: "https://api.qimanga.com/api/v1/series/title/chapters",
      method: "GET",
    });
    let interceptedRefresh: Request | undefined;
    Object.assign(Application, {
      scheduleRequest: async (request: Request): Promise<[Response, ArrayBuffer]> => {
        interceptedRefresh = await cookies.interceptRequest(request);
        const response: Response = {
          url: REFRESH_URL,
          status: 204,
          headers: {},
          cookies: [
            {
              name: "refreshToken",
              value: "new",
              domain: ".qimanga.com",
              path: "/",
            },
          ],
        };
        const data = new ArrayBuffer(0);
        await cookies.interceptResponse(interceptedRefresh, response, data);
        return [response, data];
      },
    });

    await refreshQiMangaSession(cookies);
    assert.deepEqual(interceptedRefresh?.cookies, { refreshToken: "old" });
    assert.equal(cookies.cookies.find(({ name }) => name === "refreshToken")?.value, "new");

    await cookies.interceptResponse(
      staleRequest,
      {
        url: staleRequest.url,
        status: 200,
        headers: {},
        cookies: [{ name: "refreshToken", value: "stale", domain: ".qimanga.com", path: "/" }],
      },
      new ArrayBuffer(0),
    );
    assert.equal(cookies.cookies.find(({ name }) => name === "refreshToken")?.value, "new");
  });

  it("rejects late refresh cookies after the refresh deadline expires", async () => {
    const cookies = new QiMangaCookieInterceptor();
    cookies.setCookie({
      name: "refreshToken",
      value: "old",
      domain: ".qimanga.com",
      path: "/",
    });
    let releaseResponse!: () => void;
    let markCompleted!: () => void;
    const responseGate = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    const completed = new Promise<void>((resolve) => {
      markCompleted = resolve;
    });
    Object.assign(Application, {
      scheduleRequest: async (request: Request): Promise<[Response, ArrayBuffer]> => {
        const intercepted = await cookies.interceptRequest(request);
        await responseGate;
        const response: Response = {
          url: request.url,
          status: 204,
          headers: {},
          cookies: [
            {
              name: "refreshToken",
              value: "late",
              domain: ".qimanga.com",
              path: "/",
            },
          ],
        };
        const data = new ArrayBuffer(0);
        await cookies.interceptResponse(intercepted, response, data);
        markCompleted();
        return [response, data];
      },
    });

    await assert.rejects(refreshQiMangaSession(cookies, 5), /could not be completed safely/i);
    assert.equal(
      cookies.cookies.some(({ name }) => name === "refreshToken"),
      false,
    );

    releaseResponse();
    await completed;
    assert.equal(
      cookies.cookies.some(({ value }) => value === "late"),
      false,
    );
  });

  it("does not let a late logout response clear a newer login", async () => {
    const cookies = new QiMangaCookieInterceptor();
    cookies.setCookie({
      name: "accessToken",
      value: "account-a",
      domain: ".qimanga.com",
      path: "/",
    });
    let releaseLogout!: () => void;
    let markLogoutStarted!: () => void;
    let sentLogoutCookies: Record<string, string> | undefined;
    const logoutGate = new Promise<void>((resolve) => {
      releaseLogout = resolve;
    });
    const logoutStarted = new Promise<void>((resolve) => {
      markLogoutStarted = resolve;
    });
    Object.assign(Application, {
      scheduleRequest: async (request: Request): Promise<[Response, ArrayBuffer]> => {
        const intercepted = await cookies.interceptRequest(request);
        sentLogoutCookies = intercepted.cookies;
        markLogoutStarted();
        await logoutGate;
        const response: Response = {
          url: request.url,
          status: 204,
          headers: {},
          cookies: [
            {
              name: "accessToken",
              value: "",
              domain: ".qimanga.com",
              path: "/",
              expires: new Date(0),
            },
          ],
        };
        const data = new ArrayBuffer(0);
        await cookies.interceptResponse(intercepted, response, data);
        return [response, data];
      },
    });

    const logout = signOutQiManga(cookies);
    await logoutStarted;
    assert.deepEqual(sentLogoutCookies, { accessToken: "account-a" });
    replaceQiMangaCookies(cookies, [
      { name: "accessToken", value: "account-b", domain: ".qimanga.com", path: "/" },
    ]);
    releaseLogout();
    await logout;

    assert.deepEqual(
      cookies.cookies.map(({ value }) => value),
      ["account-b"],
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
