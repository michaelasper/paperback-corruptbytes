import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import type { Request, Response } from "@paperback/types";

import { DEFAULT_MAX_RESPONSE_BYTES } from "../shared/http.js";
import {
  AUTH_REFRESH_URL,
  buildCatalogUrl,
  buildChapterAjaxRequests,
  buildMangaUrl,
  buildRefreshRequest,
  fetchText,
  fetchTextResponse,
  parseMangaUrl,
} from "./network.js";

type ApplicationMock = {
  arrayBufferToUTF8String(buffer: ArrayBuffer): string;
  scheduleRequest(request: Request): Promise<[Response, ArrayBuffer]>;
};

const originalApplication = globalThis.Application;

const encode = (value: string): ArrayBuffer => new TextEncoder().encode(value).buffer;

const installApplication = (status: number, body: string, responseUrl?: string): Request[] => {
  const requests: Request[] = [];
  const mock: ApplicationMock = {
    arrayBufferToUTF8String: (buffer) => new TextDecoder().decode(buffer),
    scheduleRequest: async (request) => {
      requests.push(request);
      return [
        {
          url: responseUrl ?? request.url,
          status,
          headers: {},
          cookies: [],
        } as Response,
        encode(body),
      ];
    },
  };

  Object.assign(globalThis, { Application: mock });
  return requests;
};

afterEach(() => {
  Object.assign(globalThis, { Application: originalApplication });
});

describe("MadaraDex routes", () => {
  it("does not depend on the browser URL global missing from Paperback", () => {
    const browserURL = globalThis.URL;
    try {
      Object.assign(globalThis, { URL: undefined });
      assert.equal(
        buildCatalogUrl({ title: "" }, { id: "latest", label: "Latest" }, 1),
        "https://madaradex.org/title/?m_orderby=latest",
      );
      assert.equal(parseMangaUrl("https://madaradex.org/?p=2872"), "2872");
    } finally {
      Object.assign(globalThis, { URL: browserURL });
    }
  });

  it("preserves archived numeric manga IDs and resolves pasted URLs", () => {
    assert.equal(buildMangaUrl("2872"), "https://madaradex.org/?p=2872");
    assert.equal(parseMangaUrl("https://madaradex.org/?p=2872"), "2872");
    assert.equal(parseMangaUrl("https://madaradex.org/title/savage-hero/"), undefined);
    assert.throws(() => buildMangaUrl("savage-hero"), /numeric/i);
  });

  it("builds deterministic listing and complete advanced-search URLs", () => {
    assert.equal(
      buildCatalogUrl({ title: "" }, { id: "latest", label: "Latest" }, 2),
      "https://madaradex.org/title/page/2/?m_orderby=latest",
    );

    const url = new URL(
      buildCatalogUrl(
        {
          title: "  magic   hero  ",
          metadata: {
            genres: ["martial-arts", "action"],
            genreCondition: "and",
            author: "Yönoki",
            artist: "Studio A",
            release: "2026",
            adult: "none",
            status: ["end", "on-going"],
          },
        },
        { id: "rating", label: "Rating" },
        3,
      ),
    );
    assert.equal(url.pathname, "/page/3/");
    assert.equal(url.searchParams.get("s"), "magic hero");
    assert.equal(url.searchParams.get("post_type"), "wp-manga");
    assert.deepEqual(url.searchParams.getAll("genre[]"), ["action", "martial-arts"]);
    assert.equal(url.searchParams.get("op"), "1");
    assert.equal(url.searchParams.get("author"), "Yönoki");
    assert.equal(url.searchParams.get("artist"), "Studio A");
    assert.equal(url.searchParams.get("release"), "2026");
    assert.equal(url.searchParams.get("adult"), "0");
    assert.deepEqual(url.searchParams.getAll("status[]"), ["end", "on-going"]);
    assert.equal(url.searchParams.get("m_orderby"), "rating");
  });

  it("builds both known Madara chapter endpoints and the internal auth refresh", () => {
    const requests = buildChapterAjaxRequests("2872");
    assert.equal(requests.length, 2);
    assert.equal(requests[0]?.url, "https://madaradex.org/wp-admin/admin-ajax.php");
    assert.equal(typeof requests[0]?.body, "string");
    assert.equal(typeof requests[1]?.body, "string");
    assert.match(requests[0]?.body as string, /action=manga_get_chapters&manga=2872/);
    assert.match(requests[1]?.body as string, /action=ajax_chap/);

    const auth = buildRefreshRequest();
    assert.equal(auth.url, AUTH_REFRESH_URL);
    assert.equal(auth.method, "POST");
    assert.equal(auth.headers?.["x-mdx-auth-refresh"], "1");
    assert.equal(auth.body, "action=mdx_auth_refresh");
  });
});

describe("MadaraDex response handling", () => {
  it("keeps response metadata and body available for non-success AJAX responses", async () => {
    installApplication(503, "temporarily unavailable");

    const result = await fetchTextResponse({
      url: "https://madaradex.org/wp-admin/admin-ajax.php",
      method: "POST",
    });

    assert.equal(result.response.status, 503);
    assert.equal(result.body, "temporarily unavailable");
  });

  it("rejects oversized responses before decoding them", async () => {
    let decodeCalls = 0;
    installApplication(200, "x".repeat(8 * 1_024 * 1_024 + 1));
    Object.assign(globalThis.Application, {
      arrayBufferToUTF8String: (buffer: ArrayBuffer) => {
        decodeCalls += 1;
        return new TextDecoder().decode(buffer);
      },
    });

    await assert.rejects(
      fetchTextResponse({
        url: "https://madaradex.org/wp-admin/admin-ajax.php?token=secret",
        method: "POST",
      }),
      /MadaraDex.*too large/i,
    );
    assert.equal(decodeCalls, 0);
  });

  it("classifies oversized ordinary HTTP failures before enforcing the body limit", async () => {
    let decodeCalls = 0;

    for (const [status, message] of [
      [401, /status 401/i],
      [404, /content not found/i],
      [500, /status 500/i],
    ] as const) {
      installApplication(status, "x".repeat(DEFAULT_MAX_RESPONSE_BYTES + 1));
      Object.assign(globalThis.Application, {
        arrayBufferToUTF8String: () => {
          decodeCalls += 1;
          return "unexpected";
        },
      });
      await assert.rejects(
        fetchText({ url: "https://madaradex.org/private", method: "GET" }),
        message,
      );
    }

    assert.equal(decodeCalls, 0);
  });

  it("rejects foreign initial requests and redirected responses before decoding", async () => {
    const initialRequests = installApplication(200, "private");
    await assert.rejects(
      fetchText({ url: "https://evil.example/metadata", method: "GET" }),
      /response URL was not trusted/i,
    );
    assert.equal(initialRequests.length, 0);

    let decodeCalls = 0;
    installApplication(200, "private", "https://evil.example/redirected");
    Object.assign(globalThis.Application, {
      arrayBufferToUTF8String: () => {
        decodeCalls += 1;
        return "private";
      },
    });
    await assert.rejects(
      fetchText({ url: "https://madaradex.org/metadata", method: "GET" }),
      /response URL was not trusted/i,
    );
    assert.equal(decodeCalls, 0);
  });

  it("surfaces status failures without echoing response bodies or query secrets", async () => {
    for (const [status, message] of [
      [404, /content not found/i],
      [429, /rate limit/i],
      [500, /status 500/i],
    ] as const) {
      installApplication(status, "private server detail".repeat(100));
      await assert.rejects(
        fetchText({
          url: "https://madaradex.org/private?token=secret",
          method: "GET",
        }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, message);
          assert.doesNotMatch(error.message, /private server detail|token=secret/i);
          return true;
        },
      );
    }
  });
});
