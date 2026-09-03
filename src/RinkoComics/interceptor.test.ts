import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { Request, Response } from "@paperback/types";

import { RinkoComicsInterceptor } from "./interceptor.js";
import { AJAX_URL, CDN_DOMAIN, DOMAIN, MAX_MEDIA_RESPONSE_BYTES } from "./network.js";

const originalApplication = globalThis.Application;

beforeEach(() => {
  Object.assign(globalThis, {
    Application: {
      getDefaultUserAgent: async () => "Paperback/Test",
    },
  });
});

afterEach(() => Object.assign(globalThis, { Application: originalApplication }));

describe("Rinko Comics interceptor", () => {
  it("reconstructs first-party requests without cookies, credentials, or forged fields", async () => {
    const interceptor = new RinkoComicsInterceptor();
    const request = {
      url: `${DOMAIN}/comic/fixture/`,
      method: "get",
      headers: {
        accept: "text/html",
        authorization: "Bearer secret",
        cookie: "session=secret",
        "x-forged": "secret",
      },
      cookies: { session: "secret" },
      forged: "secret",
    } as Request & { forged: string };
    const result = await interceptor.interceptRequest(request);
    assert.deepEqual(result, {
      url: `${DOMAIN}/comic/fixture/`,
      method: "GET",
      headers: {
        accept: "text/html",
        referer: `${DOMAIN}/`,
        "accept-language": "en-US,en;q=0.9",
        "user-agent": "Paperback/Test",
      },
    });
    assert.equal(request.cookies, undefined);
    assert.equal(request.headers?.authorization, undefined);
    assert.equal(request.headers?.cookie, undefined);
  });

  it("keeps reader CDN requests credential-neutral and allowlisted", async () => {
    const interceptor = new RinkoComicsInterceptor();
    const result = await interceptor.interceptRequest({
      url: `${CDN_DOMAIN}/wp-content/uploads/comics/fixture/1/01.webp`,
      method: "HEAD",
      headers: {
        accept: "image/webp",
        range: "bytes=0-10",
        referer: `${DOMAIN}/private/account`,
        origin: DOMAIN,
        authorization: "secret",
      },
      cookies: { account: "secret" },
    });
    assert.deepEqual(result, {
      url: `${CDN_DOMAIN}/wp-content/uploads/comics/fixture/1/01.webp`,
      method: "HEAD",
      headers: {
        accept: "image/webp",
        range: "bytes=0-10",
        "user-agent": "Paperback/Test",
      },
    });
  });

  it("allows only the exact bounded public AJAX POST contract", async () => {
    const interceptor = new RinkoComicsInterceptor();
    const result = await interceptor.interceptRequest({
      url: AJAX_URL,
      method: "POST",
      headers: {
        accept: "application/json, text/javascript, */*; q=0.01",
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        origin: DOMAIN,
        referer: `${DOMAIN}/comic/fixture/`,
        "x-requested-with": "XMLHttpRequest",
      },
      body: "action=load_more_chapters&nonce=abc&comic_id=1&offset=10",
      cookies: { session: "secret" },
    });
    assert.equal(result.body, "action=load_more_chapters&nonce=abc&comic_id=1&offset=10");
    assert.equal(result.cookies, undefined);
    await assert.rejects(
      interceptor.interceptRequest({
        url: `${DOMAIN}/login/`,
        method: "POST",
        body: "username=user&password=secret",
      }),
      /POST request URL is invalid/i,
    );
    await assert.rejects(
      interceptor.interceptRequest({ url: AJAX_URL, method: " POST ", body: "x" }),
      /method is invalid/i,
    );
    await assert.rejects(
      interceptor.interceptRequest({
        url: AJAX_URL,
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
          origin: DOMAIN,
          referer: `${DOMAIN}/comic/fixture/`,
          "x-requested-with": "XMLHttpRequest",
        },
        body: "action=load_more_chapters&nonce=abc&comic_id=1&offset=10",
      }),
      /AJAX request headers are invalid/i,
    );
    await assert.rejects(
      interceptor.interceptRequest({
        url: AJAX_URL,
        method: "POST",
        headers: {
          accept: "application/json, text/javascript, */*; q=0.01",
          "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
          origin: DOMAIN,
          referer: `${DOMAIN}/comic/fixture/?token=secret`,
          "x-requested-with": "XMLHttpRequest",
        },
        body: "action=load_more_chapters&nonce=abc&comic_id=1&offset=10",
      }),
      /AJAX request headers are invalid/i,
    );
  });

  it("rejects first-party paths and query shapes the source never emits", async () => {
    const interceptor = new RinkoComicsInterceptor();
    await assert.rejects(
      interceptor.interceptRequest({ url: `${DOMAIN}/wp-login.php`, method: "GET" }),
      /URL is not trusted/i,
    );
    await assert.rejects(
      interceptor.interceptRequest({
        url: `${DOMAIN}/wp-json/wp/v2/comic?per_page=20&page=1&_embed=wp%3Afeaturedmedia%2Cwp%3Aterm&token=secret`,
        method: "GET",
      }),
      /URL is not trusted/i,
    );
    await assert.rejects(
      interceptor.interceptRequest({
        url: `${DOMAIN}/comic/?sort=az&post_type=comic`,
        method: "GET",
      }),
      /URL is not trusted/i,
    );
  });

  it("bounds and validates caller header maps before forwarding", async () => {
    const interceptor = new RinkoComicsInterceptor();
    const tooMany: Record<string, string> = {};
    for (let index = 0; index <= 256; index += 1) tooMany[`x-${index}`] = "value";
    await assert.rejects(
      interceptor.interceptRequest({
        url: `${DOMAIN}/comic/fixture/`,
        method: "GET",
        headers: tooMany,
      }),
      /too many headers/i,
    );
    for (const malformedValue of [
      "text/html\r\nAuthorization: secret",
      "text/html\0Authorization: secret",
      "text/html\u00adAuthorization: secret",
      "text/html\u2028Authorization: secret",
    ]) {
      await assert.rejects(
        interceptor.interceptRequest({
          url: `${DOMAIN}/comic/fixture/`,
          method: "GET",
          headers: { accept: malformedValue },
        }),
        (error: unknown) =>
          error instanceof Error &&
          error.message === "Rinko Comics request headers are invalid." &&
          !error.message.includes("secret") &&
          !("cause" in error),
      );
    }
    await assert.rejects(
      interceptor.interceptRequest({
        url: `${DOMAIN}/comic/fixture/`,
        method: "GET",
        headers: { "x-untrusted": 7 as unknown as string },
      }),
      /headers are invalid/i,
    );
    const inheritedInvalid = Object.create({ "bad header": "secret" }) as Record<string, string>;
    await assert.rejects(
      interceptor.interceptRequest({
        url: `${DOMAIN}/comic/fixture/`,
        method: "GET",
        headers: inheritedInvalid,
      }),
      /headers are invalid/i,
    );
    for (const inheritedHeader of [7, "x".repeat(16 * 1_024 + 1), "value\r\nsecret"]) {
      const inheritedValue = Object.create({ "x-inherited": inheritedHeader }) as Record<
        string,
        string
      >;
      inheritedValue.accept = "text/html";
      await assert.rejects(
        interceptor.interceptRequest({
          url: `${DOMAIN}/comic/fixture/`,
          method: "GET",
          headers: inheritedValue,
        }),
        /headers are invalid/i,
      );
    }
    const throwingPrototype = {};
    Object.defineProperty(throwingPrototype, "x-inherited", {
      enumerable: true,
      get() {
        throw new Error("token=secret");
      },
    });
    const throwingInherited = Object.create(throwingPrototype) as Record<string, string>;
    throwingInherited.accept = "text/html";
    await assert.rejects(
      interceptor.interceptRequest({
        url: `${DOMAIN}/comic/fixture/`,
        method: "GET",
        headers: throwingInherited,
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, "Rinko Comics request headers are invalid.");
        assert.equal(error.cause, undefined);
        return true;
      },
    );
    const inheritedDuplicate = Object.create({ Accept: "text/html" }) as Record<string, string>;
    inheritedDuplicate.accept = "text/html";
    await assert.rejects(
      interceptor.interceptRequest({
        url: `${DOMAIN}/comic/fixture/`,
        method: "GET",
        headers: inheritedDuplicate,
      }),
      /headers are invalid/i,
    );
    const symbolHeaders = { accept: "text/html" } as Record<PropertyKey, unknown>;
    Object.defineProperty(symbolHeaders, Symbol("token"), {
      value: "secret",
      enumerable: true,
    });
    await assert.rejects(
      interceptor.interceptRequest({
        url: `${DOMAIN}/comic/fixture/`,
        method: "GET",
        headers: symbolHeaders as Record<string, string>,
      }),
      /headers are invalid/i,
    );
    const hostileHeaders = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error("token=secret");
        },
      },
    );
    await assert.rejects(
      interceptor.interceptRequest({
        url: `${DOMAIN}/comic/fixture/`,
        method: "GET",
        headers: hostileHeaders,
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, "Rinko Comics request headers are invalid.");
        assert.equal(error.cause, undefined);
        return true;
      },
    );
  });

  it("bounds media responses and requires successful non-active image content", async () => {
    const interceptor = new RinkoComicsInterceptor();
    const request: Request = {
      url: `${CDN_DOMAIN}/wp-content/uploads/comics/fixture/1/01.webp`,
      method: "GET",
    };
    let statusReads = 0;
    let headerReads = 0;
    const response = { url: request.url } as Response;
    Object.defineProperties(response, {
      status: {
        enumerable: true,
        get() {
          statusReads += 1;
          if (statusReads > 1) throw new Error("token=secret");
          return 206;
        },
      },
      headers: {
        enumerable: true,
        get() {
          headerReads += 1;
          if (headerReads > 1) throw new Error("token=secret");
          return { "content-type": "image/webp", "content-range": "bytes 0-3/4" };
        },
      },
    });
    const body = new ArrayBuffer(4);
    assert.equal(await interceptor.interceptResponse(request, response, body), body);
    assert.equal(statusReads, 1);
    assert.equal(headerReads, 1);

    const rejected: Array<{ response: Response; body: ArrayBuffer }> = [
      {
        response: {
          url: request.url,
          status: 500,
          headers: { "content-type": "image/webp" },
          cookies: [],
        },
        body,
      },
      {
        response: {
          url: request.url,
          status: 200,
          headers: { "content-type": "text/html" },
          cookies: [],
        },
        body,
      },
      {
        response: {
          url: request.url,
          status: 200,
          headers: { "content-type": "image/svg+xml" },
          cookies: [],
        },
        body,
      },
      {
        response: {
          url: request.url,
          status: 200,
          headers: { "content-type": "image/webp;\0text/html" },
          cookies: [],
        },
        body,
      },
      {
        response: {
          url: request.url,
          status: 200,
          headers: { "content-type": "image/webp\u2028;text/html" },
          cookies: [],
        },
        body,
      },
      {
        response: {
          url: request.url,
          status: 200,
          headers: { "content-type": "image/webp" },
          cookies: [],
        },
        body: new ArrayBuffer(MAX_MEDIA_RESPONSE_BYTES + 1),
      },
      {
        response: {
          url: request.url,
          status: "200" as unknown as number,
          headers: { "content-type": "image/webp" },
          cookies: [],
        },
        body,
      },
    ];
    for (const candidate of rejected) {
      await assert.rejects(
        interceptor.interceptResponse(request, candidate.response, candidate.body),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.equal(error.message, "Rinko Comics returned an untrusted response.");
          assert.equal(error.cause, undefined);
          return true;
        },
      );
    }

    const hostileStatus = {
      url: request.url,
      headers: { "content-type": "image/webp" },
    } as unknown as Response;
    Object.defineProperty(hostileStatus, "status", {
      enumerable: true,
      get() {
        throw new Error("token=secret");
      },
    });
    const hiddenHeaders = Object.defineProperty({ "content-type": "image/webp" }, "token", {
      value: "secret",
      enumerable: false,
    });
    for (const hostileResponse of [
      hostileStatus,
      { url: request.url, status: 200, headers: hiddenHeaders, cookies: [] },
    ]) {
      await assert.rejects(
        interceptor.interceptResponse(request, hostileResponse, body),
        (error: unknown) =>
          error instanceof Error &&
          error.message === "Rinko Comics returned an untrusted response." &&
          !error.message.includes("secret") &&
          !("cause" in error),
      );
    }

    let resizableResponseReads = 0;
    const resizableBody = new ArrayBuffer(1, { maxByteLength: MAX_MEDIA_RESPONSE_BYTES + 1 });
    const resizableResponse = Object.defineProperties(
      { headers: { "content-type": "image/webp" } },
      {
        url: {
          enumerable: true,
          get() {
            resizableResponseReads += 1;
            return request.url;
          },
        },
        status: {
          enumerable: true,
          get() {
            resizableResponseReads += 1;
            resizableBody.resize(MAX_MEDIA_RESPONSE_BYTES + 1);
            return 200;
          },
        },
      },
    ) as unknown as Response;
    await assert.rejects(
      interceptor.interceptResponse(request, resizableResponse, resizableBody),
      /untrusted response/i,
    );
    assert.equal(resizableResponseReads, 0);

    const detachedBody = new ArrayBuffer(0);
    structuredClone(detachedBody, { transfer: [detachedBody] });
    await assert.rejects(
      interceptor.interceptResponse(
        request,
        {
          url: request.url,
          status: 200,
          headers: { "content-type": "image/webp" },
          cookies: [],
        },
        detachedBody,
      ),
      /untrusted response/i,
    );

    let detachOnUrlLaterReads = 0;
    const detachOnUrlBody = new ArrayBuffer(0);
    const detachOnUrlResponse = Object.defineProperties(
      { cookies: [] },
      {
        url: {
          enumerable: true,
          get() {
            structuredClone(detachOnUrlBody, { transfer: [detachOnUrlBody] });
            return request.url;
          },
        },
        status: {
          enumerable: true,
          get() {
            detachOnUrlLaterReads += 1;
            return 200;
          },
        },
        headers: {
          enumerable: true,
          get() {
            detachOnUrlLaterReads += 1;
            return { "content-type": "image/webp" };
          },
        },
      },
    ) as unknown as Response;
    await assert.rejects(
      interceptor.interceptResponse(request, detachOnUrlResponse, detachOnUrlBody),
      /untrusted response/i,
    );
    assert.equal(detachOnUrlLaterReads, 0);

    const coverRequest: Request = {
      url: `${DOMAIN}/wp-content/uploads/2026/01/cover.webp`,
      method: "GET",
    };
    assert.equal(
      await interceptor.interceptResponse(
        coverRequest,
        {
          url: coverRequest.url,
          status: 200,
          headers: { "content-type": "image/webp" },
          cookies: [],
        },
        body,
      ),
      body,
    );
    await assert.rejects(
      interceptor.interceptResponse(
        coverRequest,
        {
          url: coverRequest.url,
          status: 500,
          headers: { "content-type": "text/html" },
          cookies: [],
        },
        body,
      ),
      /untrusted response/i,
    );
  });

  it("allows redirects only within the same explicit origin class", async () => {
    const interceptor = new RinkoComicsInterceptor();
    const response = (url: string): Response => ({ url, status: 302, headers: {}, cookies: [] });
    assert.ok(
      await interceptor.interceptRedirect(
        { url: `${DOMAIN}/comic/fixture/`, method: "GET" },
        response(`${DOMAIN}/comic/old/`),
      ),
    );
    assert.ok(
      await interceptor.interceptRedirect(
        {
          url: `${CDN_DOMAIN}/wp-content/uploads/comics/fixture/1/02.webp`,
          method: "GET",
        },
        response(`${CDN_DOMAIN}/wp-content/uploads/comics/fixture/1/01.webp`),
      ),
    );
    assert.equal(
      await interceptor.interceptRedirect(
        { url: "https://evil.example/private", method: "GET" },
        response(`${DOMAIN}/comic/fixture/`),
      ),
      undefined,
    );
    assert.equal(
      await interceptor.interceptRedirect(
        { url: `${DOMAIN}/comic/fixture/`, method: "GET" },
        response(`${DOMAIN}/wp-content/uploads/2026/01/cover.webp`),
      ),
      undefined,
    );
    assert.equal(
      await interceptor.interceptRedirect(
        { url: `${DOMAIN}/comic/fixture/`, method: "POST", body: "secret" },
        response(`${DOMAIN}/comic/old/`),
      ),
      undefined,
    );
  });

  it("does not provide anti-bot bypass behavior and rejects foreign response origins", async () => {
    const interceptor = new RinkoComicsInterceptor();
    const body = new TextEncoder().encode("<html>challenge</html>").buffer;
    assert.equal(
      await interceptor.interceptResponse(
        { url: `${DOMAIN}/comic/fixture/`, method: "GET" },
        {
          url: `${DOMAIN}/comic/fixture/`,
          status: 403,
          headers: { "cf-mitigated": "challenge", "content-type": "text/html" },
          cookies: [],
        },
        body,
      ),
      body,
    );
    const mismatches: Array<[Request, Response]> = [
      [
        { url: `${DOMAIN}/comic/fixture/`, method: "GET" },
        { url: "https://evil.example/private", status: 200, headers: {}, cookies: [] },
      ],
      [
        { url: `${DOMAIN}/comic/fixture/`, method: "GET" },
        { url: `${DOMAIN}/comic/other/`, status: 200, headers: {}, cookies: [] },
      ],
      [
        { url: `${DOMAIN}/comic/fixture/`, method: "POST", body: "secret" },
        { url: `${DOMAIN}/comic/fixture/`, status: 200, headers: {}, cookies: [] },
      ],
    ];
    for (const [request, response] of mismatches) {
      await assert.rejects(
        interceptor.interceptResponse(request, response, body),
        /untrusted response/i,
      );
    }
    await assert.rejects(
      interceptor.interceptResponse(
        { url: `${DOMAIN}/comic/fixture/`, method: "GET" },
        { url: `${DOMAIN}/comic/fixture/`, status: 200, headers: {}, cookies: [] },
        Object.create(ArrayBuffer.prototype) as ArrayBuffer,
      ),
      /untrusted response/i,
    );
  });
});
