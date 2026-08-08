import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { Request, Response } from "@paperback/types";

import { CloudflareError, VortexInterceptor } from "./interceptor.js";

const originalApplication = globalThis.Application;
const originalURL = globalThis.URL;

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
  Object.assign(globalThis, { Application: originalApplication, URL: originalURL });
});

const response = (status: number, headers: Record<string, string> = {}): Response => ({
  url: "https://api.vortexscans.org/api/me",
  status,
  headers,
  cookies: [],
});

describe("VortexInterceptor request headers", () => {
  it("keeps caller headers and cookies while adding first-party API defaults", async () => {
    const interceptor = new VortexInterceptor();
    const request: Request = {
      url: "https://api.vortexscans.org/api/query",
      method: "GET",
      headers: { "x-request-id": "retain-me" },
      cookies: { "better-auth.session_token": "session-cookie" },
    };

    const intercepted = await interceptor.interceptRequest(request);

    assert.notEqual(intercepted, request);
    assert.equal(intercepted.headers?.["x-request-id"], "retain-me");
    assert.deepEqual(intercepted.cookies, request.cookies);
    assert.equal(intercepted.headers?.referer, "https://vortexscans.org/");
    assert.equal(intercepted.headers?.origin, "https://vortexscans.org");
    assert.equal(intercepted.headers?.["user-agent"], "Paperback Test/0.9");
    assert.equal(intercepted.headers?.["accept-language"], "en-US,en;q=0.9");
    assert.match(intercepted.headers?.accept ?? "", /application\/json/i);
  });

  it("requests an image representation for common image extensions", async () => {
    const interceptor = new VortexInterceptor();
    const intercepted = await interceptor.interceptRequest({
      url: "https://vortexscans.org/uploads/page-01.webp?width=1200",
      method: "GET",
    });

    assert.match(intercepted.headers?.accept ?? "", /image\//i);
    assert.doesNotMatch(intercepted.headers?.accept ?? "", /application\/json/i);
  });

  it("recognizes first-party requests when Paperback provides no browser URL global", async () => {
    Object.assign(globalThis, { URL: undefined });
    const interceptor = new VortexInterceptor();

    const intercepted = await interceptor.interceptRequest({
      url: "https://api.vortexscans.org/api/me",
      method: "GET",
    });

    assert.equal(intercepted.headers?.origin, "https://vortexscans.org");
    assert.match(intercepted.headers?.accept ?? "", /application\/json/i);
    await assert.rejects(
      interceptor.interceptResponse(
        { url: "https://api.vortexscans.org/api/me", method: "GET" },
        response(403, { "cf-mitigated": "challenge" }),
        encode("<html><title>Just a moment...</title></html>"),
      ),
      (error: unknown) => error instanceof CloudflareError,
    );
  });

  it("does not invent authorization headers", async () => {
    const interceptor = new VortexInterceptor();
    const intercepted = await interceptor.interceptRequest({
      url: "https://api.vortexscans.org/api/me",
      method: "GET",
    });

    assert.ok(intercepted.headers);
    assert.equal(
      Object.keys(intercepted.headers).some((key) => key.toLowerCase() === "authorization"),
      false,
    );
    assert.equal(intercepted.cookies, undefined);
  });

  it("honors caller-provided header values instead of dropping them", async () => {
    const interceptor = new VortexInterceptor();
    const intercepted = await interceptor.interceptRequest({
      url: "https://api.vortexscans.org/api/me",
      method: "GET",
      headers: {
        Accept: "application/problem+json",
        "User-Agent": "Caller UA",
      },
    });

    assert.equal(intercepted.headers?.Accept, "application/problem+json");
    assert.equal(intercepted.headers?.["User-Agent"], "Caller UA");
    assert.equal(intercepted.headers?.accept, undefined);
    assert.equal(intercepted.headers?.["user-agent"], undefined);
  });
});

describe("VortexInterceptor Cloudflare detection", () => {
  it("raises CloudflareError for a case-insensitive cf-mitigated challenge", async () => {
    const interceptor = new VortexInterceptor();
    const request: Request = {
      url: "https://api.vortexscans.org/api/query",
      method: "GET",
    };

    await assert.rejects(
      interceptor.interceptResponse(
        request,
        response(403, { "CF-MITIGATED": "Challenge" }),
        encode('{"error":"challenge"}'),
      ),
      (error: unknown) => {
        assert.ok(error instanceof CloudflareError);
        assert.equal(error.resolutionRequest.url, "https://vortexscans.org/");
        assert.equal(error.resolutionRequest.method, "GET");
        return true;
      },
    );
  });

  it("raises CloudflareError for recognizable 403 and 503 HTML challenges", async () => {
    const interceptor = new VortexInterceptor();
    const request: Request = { url: "https://vortexscans.org/series/demo", method: "GET" };
    const challenge =
      "<!doctype html><html><head><title>Just a moment...</title></head>" +
      '<body><div id="challenge-platform">Checking your browser</div></body></html>';

    for (const status of [403, 503]) {
      await assert.rejects(
        interceptor.interceptResponse(
          request,
          response(status, { "Content-Type": "text/html; charset=UTF-8" }),
          encode(challenge),
        ),
        (error: unknown) => error instanceof CloudflareError,
      );
    }
  });

  it("passes through ordinary API authentication and locked errors", async () => {
    const interceptor = new VortexInterceptor();
    const request: Request = { url: "https://api.vortexscans.org/api/me", method: "GET" };

    for (const [status, body] of [
      [401, '{"message":"Unauthorized"}'],
      [403, '{"message":"Chapter is locked"}'],
      [403, "<html><body>Access denied</body></html>"],
    ] as const) {
      const data = encode(body);
      const returned = await interceptor.interceptResponse(
        request,
        response(status, { "content-type": "application/json" }),
        data,
      );
      assert.equal(returned, data);
    }
  });

  it("ignores Cloudflare challenges from unrelated image hosts", async () => {
    const interceptor = new VortexInterceptor();
    const request: Request = { url: "https://cdn.example/page.webp", method: "GET" };
    const data = encode("<!doctype html><html><head><title>Just a moment...</title></head></html>");

    const returned = await interceptor.interceptResponse(
      request,
      {
        url: request.url,
        status: 503,
        headers: { "cf-mitigated": "challenge", "content-type": "text/html" },
        cookies: [],
      },
      data,
    );

    assert.equal(returned, data);
  });
});
