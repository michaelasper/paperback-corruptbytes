import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { Request, Response } from "@paperback/types";

import { CloudflareError } from "../shared/http.js";
import { MgekoCookieInterceptor } from "./cookies.js";
import { MgekoInterceptor } from "./interceptor.js";

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

describe("Mgeko transport boundaries", () => {
  it("adds source headers only to Mgeko and keeps image CDN requests neutral", async () => {
    const interceptor = new MgekoInterceptor();
    const firstParty = await interceptor.interceptRequest({
      url: "https://www.mgeko.cc/browse-comics/data/",
      method: "GET",
    });
    const image = await interceptor.interceptRequest({
      url: "https://imgsrv5.com/pages/01.jpg",
      method: "GET",
    });
    const unlistedSubdomain = await interceptor.interceptRequest({
      url: "https://takeover.mgeko.cc/pages/01.jpg",
      method: "GET",
    });

    assert.equal(firstParty.headers?.referer, "https://www.mgeko.cc/");
    assert.equal(firstParty.headers?.["accept-language"], "en-US,en;q=0.9");
    assert.equal(image.headers?.referer, undefined);
    assert.equal(image.headers?.origin, undefined);
    assert.equal(image.headers?.["user-agent"], "Paperback/Test");
    assert.equal(unlistedSubdomain.headers?.referer, undefined);
    assert.equal(unlistedSubdomain.headers?.["accept-language"], undefined);
  });

  it("raises Cloudflare only for a verified first-party challenge", async () => {
    const interceptor = new MgekoInterceptor();
    const request: Request = { url: "https://www.mgeko.cc/", method: "GET" };
    const response: Response = {
      url: request.url,
      status: 403,
      headers: { "content-type": "text/html" },
      cookies: [],
    };
    const challenge = new TextEncoder().encode("<html><title>Just a moment</title></html>").buffer;
    await assert.rejects(
      interceptor.interceptResponse(request, response, challenge),
      CloudflareError,
    );

    assert.equal(
      await interceptor.interceptResponse(
        { url: "https://imgsrv5.com/page.jpg", method: "GET" },
        { ...response, url: "https://imgsrv5.com/page.jpg" },
        challenge,
      ),
      challenge,
    );
  });

  it("persists only source-scoped Cloudflare cookies and never sends them to image hosts", async () => {
    const cookies = new MgekoCookieInterceptor();
    cookies.setCookie({ name: "cf_clearance", value: "ok", domain: ".mgeko.cc", path: "/" });
    cookies.setCookie({ name: "sessionid", value: "no", domain: ".mgeko.cc", path: "/" });

    const site = await cookies.interceptRequest({ url: "https://www.mgeko.cc/", method: "GET" });
    const image = await cookies.interceptRequest({
      url: "https://imgsrv5.com/page.jpg",
      method: "GET",
      cookies: { cf_clearance: "caller", display: "wide" },
    });
    const unlistedSubdomain = await cookies.interceptRequest({
      url: "https://takeover.mgeko.cc/page.jpg",
      method: "GET",
      cookies: { cf_clearance: "caller", display: "wide" },
    });
    assert.deepEqual(site.cookies, { cf_clearance: "ok" });
    assert.deepEqual(image.cookies, { display: "wide" });
    assert.deepEqual(unlistedSubdomain.cookies, { display: "wide" });

    const fresh = new MgekoCookieInterceptor();
    await fresh.interceptResponse(
      { url: "https://takeover.mgeko.cc/page.jpg", method: "GET" },
      {
        url: "https://takeover.mgeko.cc/page.jpg",
        status: 200,
        headers: {},
        cookies: [{ name: "cf_clearance", value: "forged", domain: ".mgeko.cc", path: "/" }],
      },
      new ArrayBuffer(0),
    );
    assert.equal(
      fresh.cookies.some((cookie) => cookie.value === "forged"),
      false,
    );
  });
});
