import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { CloudflareError, type Response } from "@paperback/types";

import { ThunderInterceptor } from "./interceptor.js";

const originalApplication = globalThis.Application;

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

describe("ThunderInterceptor", () => {
  it("adds browser HTML headers only to the first-party site", async () => {
    const source = new ThunderInterceptor();
    const firstParty = await source.interceptRequest({
      url: "https://en-thunderscans.com/comics/",
      method: "GET",
    });
    const image = await source.interceptRequest({
      url: "https://cdn.example/page.webp",
      method: "GET",
    });

    assert.equal(firstParty.headers?.referer, "https://en-thunderscans.com/");
    assert.equal(firstParty.headers?.origin, "https://en-thunderscans.com");
    assert.match(firstParty.headers?.accept ?? "", /text\/html/);
    assert.equal(image.headers?.["user-agent"], "Paperback Test/0.9");
    assert.equal(image.headers?.referer, undefined);
    assert.equal(image.headers?.origin, undefined);
  });

  it("routes first-party Cloudflare challenges to the public homepage", async () => {
    const source = new ThunderInterceptor();
    const data = new TextEncoder().encode("<title>Just a moment...</title>").buffer;
    const response: Response = {
      url: "https://en-thunderscans.com/comics/",
      status: 503,
      headers: { "content-type": "text/html" },
      cookies: [],
    };

    await assert.rejects(
      source.interceptResponse(
        { url: "https://en-thunderscans.com/comics/", method: "GET" },
        response,
        data,
      ),
      (error: unknown) => {
        assert.ok(error instanceof CloudflareError);
        assert.equal(error.resolutionRequest.url, "https://en-thunderscans.com/");
        return true;
      },
    );
  });
});
