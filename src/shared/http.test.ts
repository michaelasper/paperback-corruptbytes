import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { CloudflareError, type Request, type Response } from "@paperback/types";

import {
  SourceRequestInterceptor,
  headerValue,
  isCloudflareChallenge,
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

  it("uses an image accept header for first-party image paths", async () => {
    const request = await interceptor().interceptRequest({
      url: "https://reader.example/uploads/page.avif?width=1200",
      method: "GET",
    });

    assert.match(request.headers?.accept ?? "", /image\//);
    assert.doesNotMatch(request.headers?.accept ?? "", /text\/html/);
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
