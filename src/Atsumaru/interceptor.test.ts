import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { Request, Response } from "@paperback/types";

import { CloudflareError } from "../shared/http.js";
import { AtsumaruInterceptor } from "./interceptor.js";

const originalApplication = globalThis.Application;

beforeEach(() => {
  Object.assign(globalThis, {
    Application: { getDefaultUserAgent: async () => "Paperback/Test" },
  });
});

afterEach(() => Object.assign(globalThis, { Application: originalApplication }));

describe("Atsumaru request interceptor", () => {
  it("adds first-party JSON/site headers but leaves CDN requests neutral", async () => {
    const interceptor = new AtsumaruInterceptor();
    const firstParty = await interceptor.interceptRequest({
      url: "https://atsu.moe/api/manga/page?id=h4j-gl",
      method: "GET",
    });
    const cdn = await interceptor.interceptRequest({
      url: "https://cdn.atsu.moe/pages/01.jpg",
      method: "GET",
    });

    assert.equal(firstParty.headers?.referer, "https://atsu.moe/");
    assert.equal(firstParty.headers?.origin, "https://atsu.moe");
    assert.equal(firstParty.headers?.["accept-language"], "en-US,en;q=0.9");
    assert.match(firstParty.headers?.accept ?? "", /application\/json/);
    assert.equal(cdn.headers?.referer, undefined);
    assert.equal(cdn.headers?.origin, undefined);
    assert.equal(cdn.headers?.["accept-language"], undefined);
    assert.equal(cdn.headers?.accept, undefined);
    assert.equal(cdn.headers?.["user-agent"], "Paperback/Test");
  });

  it("preserves caller headers and does not trust lookalike hosts", async () => {
    const interceptor = new AtsumaruInterceptor();
    const request = await interceptor.interceptRequest({
      url: "https://atsu.moe/api",
      method: "GET",
      headers: { Referer: "https://caller.example/", ACCEPT: "application/custom" },
    });
    assert.equal(request.headers?.Referer, "https://caller.example/");
    assert.equal(request.headers?.ACCEPT, "application/custom");
    const attacker = await interceptor.interceptRequest({
      url: "https://atsu.moe.evil.test/api",
      method: "GET",
    });
    assert.equal(attacker.headers?.referer, undefined);
    assert.equal(attacker.headers?.origin, undefined);
  });

  it("raises Cloudflare only for a verified first-party HTML challenge", async () => {
    const interceptor = new AtsumaruInterceptor();
    const request: Request = { url: "https://atsu.moe/", method: "GET" };
    const response: Response = {
      url: request.url,
      status: 403,
      headers: { "content-type": "text/html" },
      cookies: [],
    };
    const challenge = new TextEncoder().encode(
      "<html><title>Just a moment...</title><div>Checking your browser</div></html>",
    ).buffer;
    await assert.rejects(
      interceptor.interceptResponse(request, response, challenge),
      CloudflareError,
    );

    const cdnResponse: Response = { ...response, url: "https://cdn.atsu.moe/page.jpg" };
    assert.equal(
      await interceptor.interceptResponse(
        { url: "https://cdn.atsu.moe/page.jpg", method: "GET" },
        cdnResponse,
        challenge,
      ),
      challenge,
    );
  });
});
