import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { CloudflareError, type Request, type Response } from "@paperback/types";

import {
  assertResponseBodyWithinLimit,
  SourceHttpError,
  SourceRequestInterceptor,
  fetchSourceJson,
  fetchSourceText,
  headerValue,
  isCloudflareChallenge,
  requestContext,
  scheduleBoundedResponse,
  scheduleRawResponse,
  scheduleTextResponse,
  setHeaderIfMissing,
} from "./http.js";

const originalApplication = globalThis.Application;
const encode = (value: string): ArrayBuffer => new TextEncoder().encode(value).buffer;

beforeEach(() => {
  Object.assign(globalThis, {
    Application: {
      getDefaultUserAgent: async () => "Paperback Test/0.9",
      arrayBufferToUTF8String: (buffer: ArrayBuffer) => new TextDecoder().decode(buffer),
    },
  });
});

afterEach(() => {
  Object.assign(globalThis, { Application: originalApplication });
});

const trusted = (value: string): boolean => /^https:\/\/(?:api\.)?reader\.example\//.test(value);

const interceptor = (): SourceRequestInterceptor =>
  new SourceRequestInterceptor("testSourceInterceptor", {
    sourceName: "Test Reader",
    resolutionUrl: "https://reader.example/",
    referer: "https://reader.example/",
    origin: "https://reader.example",
    acceptLanguage: "en-US,en;q=0.9",
    documentAccept: "text/html,application/xhtml+xml,*/*;q=0.8",
    isFirstPartyUrl: trusted,
  });

describe("shared HTTP headers", () => {
  it("reads and sets headers without duplicating caller-provided casing", () => {
    const headers = { Accept: "application/json" };

    assert.equal(headerValue(headers, "accept"), "application/json");
    setHeaderIfMissing(headers, "accept", "text/html");
    setHeaderIfMissing(headers, "x-test", "present");

    assert.deepEqual(headers, { Accept: "application/json", "x-test": "present" });
  });

  it("adds source headers only to trusted HTTPS requests", async () => {
    const source = interceptor();
    const firstParty = await source.interceptRequest({
      url: "https://api.reader.example/comics/",
      method: "GET",
      headers: { "x-request-id": "keep" },
      cookies: { session: "keep" },
    });
    const thirdParty = await source.interceptRequest({
      url: "https://cdn.example/page.webp",
      method: "GET",
    });

    assert.equal(firstParty.headers?.referer, "https://reader.example/");
    assert.equal(firstParty.headers?.origin, "https://reader.example");
    assert.equal(firstParty.headers?.["accept-language"], "en-US,en;q=0.9");
    assert.match(firstParty.headers?.accept ?? "", /text\/html/);
    assert.equal(firstParty.headers?.["x-request-id"], "keep");
    assert.deepEqual(firstParty.cookies, { session: "keep" });

    assert.equal(thirdParty.headers?.["user-agent"], "Paperback Test/0.9");
    assert.equal(thirdParty.headers?.referer, undefined);
    assert.equal(thirdParty.headers?.origin, undefined);
    assert.equal(thirdParty.headers?.accept, undefined);
  });

  it("removes caller credentials and navigation headers from untrusted requests", async () => {
    const request = await interceptor().interceptRequest({
      url: "https://cdn.example/page.webp",
      method: "GET",
      headers: {
        Cookie: "session=private",
        aUtHoRiZaTiOn: "Bearer private",
        ORIGIN: "https://reader.example",
        Referer: "https://reader.example/secret",
        "X-Request-ID": "keep",
      },
    });

    const headerNames = Object.keys(request.headers ?? {}).map((name) => name.toLowerCase());
    for (const sensitive of ["cookie", "authorization", "origin", "referer"]) {
      assert.equal(headerNames.includes(sensitive), false, `unexpected ${sensitive} header`);
    }
    assert.equal(request.headers?.["X-Request-ID"], "keep");
  });

  it("uses an image accept header for first-party image paths", async () => {
    const request = await interceptor().interceptRequest({
      url: "https://reader.example/uploads/page.avif?width=1200",
      method: "GET",
    });

    assert.match(request.headers?.accept ?? "", /image\//);
    assert.doesNotMatch(request.headers?.accept ?? "", /text\/html/);
  });
});

describe("shared request context", () => {
  it("retains origin and path while redacting credentials, queries, and fragments", () => {
    assert.equal(
      requestContext(
        "https://reader-user:reader-secret@example.test/private?token=secret#private-fragment",
      ),
      "https://example.test/private",
    );
  });

  it("removes control characters from malformed context without exposing secrets", () => {
    const context = requestContext("not a URL\u0000\u000a?token=secret#private-fragment");
    assert.equal(context, "not a URL");
    assert.equal(context.includes("\u0000"), false);
    assert.equal(context.includes("\n"), false);
    assert.doesNotMatch(context, /token=secret|private-fragment/i);
  });

  it("redacts userinfo from malformed scheme-less context", () => {
    const context = requestContext("reader:secret@example.test/private?token=secret");
    assert.equal(context, "example.test/private");
    assert.doesNotMatch(context, /reader|secret|token/i);
  });
});

describe("shared Cloudflare detection", () => {
  const response = (status: number, headers: Record<string, string> = {}): Response => ({
    url: "https://reader.example/comics/",
    status,
    headers,
    cookies: [],
  });

  it("detects explicit mitigation headers and recognizable HTML challenges", () => {
    assert.equal(
      isCloudflareChallenge(response(403, { "CF-MITIGATED": "Challenge" }), encode("{}")),
      true,
    );
    assert.equal(
      isCloudflareChallenge(
        response(503, { "content-type": "text/html" }),
        encode("<!doctype html><title>Just a moment...</title><div id='challenge-platform'>"),
      ),
      true,
    );
  });

  it("does not mistake ordinary authentication or lock errors for Cloudflare", () => {
    assert.equal(
      isCloudflareChallenge(
        response(403, { "content-type": "application/json" }),
        encode('{"message":"Chapter is locked"}'),
      ),
      false,
    );
    assert.equal(
      isCloudflareChallenge(
        response(403, { "content-type": "text/html" }),
        encode("<html><body>Access denied</body></html>"),
      ),
      false,
    );
  });

  it("does not decode an oversized challenge body during interceptor inspection", () => {
    let decodeCalls = 0;
    Object.assign(globalThis.Application, {
      arrayBufferToUTF8String: () => {
        decodeCalls += 1;
        return "<!doctype html><title>Just a moment...</title>";
      },
    });

    assert.equal(
      isCloudflareChallenge(
        response(503, { "content-type": "text/html" }),
        new ArrayBuffer(256 * 1_024 + 1),
      ),
      false,
    );
    assert.equal(decodeCalls, 0);
  });

  it("throws only when both request and response remain first party", async () => {
    const source = interceptor();
    const request: Request = { url: "https://reader.example/comics/", method: "GET" };
    const challenge = encode("<!doctype html><title>Just a moment...</title>");

    await assert.rejects(
      source.interceptResponse(request, response(503, { "content-type": "text/html" }), challenge),
      (error: unknown) => {
        assert.ok(error instanceof CloudflareError);
        assert.equal(error.resolutionRequest.url, "https://reader.example/");
        assert.match(error.message, /Test Reader/);
        return true;
      },
    );

    const redirected = {
      ...response(503, { "cf-mitigated": "challenge" }),
      url: "https://evil.example/",
    };
    assert.equal(await source.interceptResponse(request, redirected, challenge), challenge);
  });
});

describe("shared bounded response transport", () => {
  const installResponse = (
    status: number,
    body: string,
    headers: Record<string, string> = {},
  ): void => {
    Object.assign(globalThis.Application, {
      scheduleRequest: async (request: Request): Promise<[Response, ArrayBuffer]> => [
        { url: request.url, status, headers, cookies: [] },
        encode(body),
      ],
    });
  };

  it("decodes successful text once and returns response metadata when requested", async () => {
    installResponse(200, '{"ok":true}', { "content-type": "application/json" });
    const request: Request = { url: "https://reader.example/api", method: "GET" };
    assert.equal(
      await fetchSourceText(request, { sourceName: "Test Reader", maxBodyBytes: 1_024 }),
      '{"ok":true}',
    );
    const result = await scheduleTextResponse(request, {
      sourceName: "Test Reader",
      maxBodyBytes: 1_024,
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.body, '{"ok":true}');
  });

  it("rejects oversized bodies before decoding them", async () => {
    let decodeCalls = 0;
    Object.assign(globalThis.Application, {
      arrayBufferToUTF8String: (buffer: ArrayBuffer) => {
        decodeCalls += 1;
        return new TextDecoder().decode(buffer);
      },
    });
    installResponse(200, "x".repeat(33));
    await assert.rejects(
      fetchSourceText(
        { url: "https://reader.example/api", method: "GET" },
        { sourceName: "Test Reader", maxBodyBytes: 32 },
      ),
      /Test Reader.*too large/i,
    );
    assert.equal(decodeCalls, 0);
  });

  it("classifies HTTP status before enforcing the body limit", async () => {
    let decodeCalls = 0;
    Object.assign(globalThis.Application, {
      arrayBufferToUTF8String: () => {
        decodeCalls += 1;
        return "unexpected";
      },
    });
    installResponse(401, "x".repeat(33));

    await assert.rejects(
      fetchSourceText(
        { url: "https://reader.example/account", method: "GET" },
        { sourceName: "Test Reader", maxBodyBytes: 32 },
      ),
      (error: unknown) => {
        assert.ok(error instanceof SourceHttpError);
        assert.equal(error.status, 401);
        assert.match(error.message, /status 401/i);
        return true;
      },
    );
    assert.equal(decodeCalls, 0);
  });

  it("exposes status before a caller applies the body limit", async () => {
    installResponse(401, "x".repeat(33));
    const result = await scheduleRawResponse(
      { url: "https://reader.example/account", method: "GET" },
      { sourceName: "Test Reader", maxBodyBytes: 32 },
    );

    assert.equal(result.response.status, 401);
    assert.equal(result.data.byteLength, 33);
    assert.throws(
      () =>
        assertResponseBodyWithinLimit(result.data, { sourceName: "Test Reader", maxBodyBytes: 32 }),
      /Test Reader.*too large/i,
    );
  });

  it("bounds raw responses before returning them to binary consumers", async () => {
    installResponse(200, "x".repeat(33));
    await assert.rejects(
      scheduleBoundedResponse(
        { url: "https://reader.example/image.webp", method: "GET" },
        { sourceName: "Test Reader", maxBodyBytes: 32 },
      ),
      /Test Reader.*too large/i,
    );
  });

  it("rejects a response URL that leaves the caller's trusted origin", async () => {
    let decodeCalls = 0;
    let seenUrls: [string, string] | undefined;
    Object.assign(globalThis.Application, {
      arrayBufferToUTF8String: (buffer: ArrayBuffer) => {
        decodeCalls += 1;
        return new TextDecoder().decode(buffer);
      },
      scheduleRequest: async (): Promise<[Response, ArrayBuffer]> => [
        {
          url: "https://evil.example/redirected",
          status: 200,
          headers: {},
          cookies: [],
        },
        encode('{"secret":true}'),
      ],
    });

    await assert.rejects(
      scheduleTextResponse(
        { url: "https://reader.example/api", method: "GET" },
        {
          sourceName: "Test Reader",
          isResponseUrlAllowed: (requestUrl, responseUrl) => {
            seenUrls = [requestUrl, responseUrl];
            return (
              requestUrl.startsWith("https://reader.example/") &&
              responseUrl.startsWith("https://reader.example/")
            );
          },
        },
      ),
      /response URL was not trusted/i,
    );
    assert.deepEqual(seenUrls, ["https://reader.example/api", "https://evil.example/redirected"]);
    assert.equal(decodeCalls, 0);
  });

  it("rejects an untrusted initial URL before scheduling the request", async () => {
    let scheduleCalls = 0;
    Object.assign(globalThis.Application, {
      scheduleRequest: async (): Promise<[Response, ArrayBuffer]> => {
        scheduleCalls += 1;
        return [
          {
            url: "https://evil.example/should-not-run",
            status: 200,
            headers: {},
            cookies: [],
          },
          encode('{"unexpected":true}'),
        ];
      },
    });

    await assert.rejects(
      scheduleTextResponse(
        { url: "https://evil.example/api", method: "GET" },
        {
          sourceName: "Test Reader",
          isResponseUrlAllowed: (requestUrl, responseUrl) =>
            requestUrl.startsWith("https://reader.example/") &&
            responseUrl.startsWith("https://reader.example/"),
        },
      ),
      /response URL was not trusted/i,
    );
    assert.equal(scheduleCalls, 0);
  });

  it("maps common status failures without leaking response bodies", async () => {
    for (const [status, expected] of [
      [404, /not found/i],
      [429, /rate limit|wait/i],
      [503, /status 503/i],
    ] as const) {
      installResponse(status, "private server detail".repeat(100));
      await assert.rejects(
        fetchSourceText(
          { url: "https://reader.example/private?token=secret", method: "GET" },
          { sourceName: "Test Reader" },
        ),
        (error: unknown) => {
          assert.ok(error instanceof SourceHttpError);
          assert.equal(error.status, status);
          assert.equal(error.sourceName, "Test Reader");
          assert.match(error.message, expected);
          assert.doesNotMatch(error.message, /private server detail|token=secret/i);
          return true;
        },
      );
    }
  });

  it("parses JSON and distinguishes HTML/protocol failures", async () => {
    installResponse(200, '{"items":[1]}');
    assert.deepEqual(
      await fetchSourceJson<{ items: number[] }>(
        { url: "https://reader.example/api", method: "GET" },
        { sourceName: "Test Reader" },
      ),
      { items: [1] },
    );

    installResponse(200, "<!doctype html><title>Maintenance</title>");
    await assert.rejects(
      fetchSourceJson(
        { url: "https://reader.example/api", method: "GET" },
        { sourceName: "Test Reader" },
      ),
      /HTML instead of JSON/i,
    );

    installResponse(200, "not-json");
    await assert.rejects(
      fetchSourceJson(
        { url: "https://reader.example/api", method: "GET" },
        { sourceName: "Test Reader" },
      ),
      /invalid JSON/i,
    );
  });
});

describe("shared redirect policy", () => {
  it("installs a fail-closed per-hop redirect guard when the runtime supports it", async () => {
    let redirectHandler:
      | ((proposedRequest: Request, redirectedResponse: Response) => Promise<Request | undefined>)
      | undefined;
    Object.assign(globalThis.Application, {
      registerInterceptor: () => undefined,
      unregisterInterceptor: () => undefined,
      Selector: (base: Record<string, unknown>, key: string) => ({ base, key }),
      setRedirectHandler: (selector: { base: Record<string, unknown>; key: string }) => {
        redirectHandler = (proposedRequest, redirectedResponse) =>
          (selector.base[selector.key] as typeof redirectHandler)!(
            proposedRequest,
            redirectedResponse,
          );
      },
    });

    const source = interceptor();
    source.registerInterceptor();
    assert.ok(redirectHandler);

    const allowed = { url: "https://api.reader.example/next", method: "GET" };
    const original = { url: "https://reader.example/start", status: 302 } as Response;
    assert.deepEqual(await redirectHandler(allowed, original), allowed);

    const foreign = { url: "https://evil.example/next", method: "GET" };
    assert.equal(await redirectHandler(foreign, original), undefined);

    const neutralImageResponse = {
      url: "https://imgsrv5.com/original.webp",
      status: 302,
    } as Response;
    const neutralImage = {
      url: "https://cdn.images.example/page.webp",
      method: "GET",
      body: "private-body",
      headers: {
        Authorization: "Bearer caller-secret",
        Cookie: "session=caller-secret",
        Origin: "https://reader.example",
        Referer: "https://reader.example/series",
        Accept: "image/webp",
      },
      cookies: { session: "caller-secret" },
    };
    const continuedImage = await redirectHandler(neutralImage, neutralImageResponse);
    assert.deepEqual(continuedImage, {
      url: neutralImage.url,
      method: neutralImage.method,
      headers: { Accept: "image/webp" },
    });

    const neutralHead = await redirectHandler(
      {
        ...neutralImage,
        method: "head",
      },
      neutralImageResponse,
    );
    assert.deepEqual(neutralHead, {
      url: neutralImage.url,
      method: "head",
      headers: { Accept: "image/webp" },
    });

    assert.equal(
      await redirectHandler({ ...neutralImage, method: "POST" }, neutralImageResponse),
      undefined,
    );

    const insecureImage = { ...neutralImage, url: "http://cdn.images.example/page.webp" };
    assert.equal(await redirectHandler(insecureImage, neutralImageResponse), undefined);

    source.unregisterInterceptor();
  });
});
