import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import type { Request, Response, SearchQuery, SortingOption } from "@paperback/types";

import type { ThunderSearchMetadata } from "./models.js";
import {
  AJAX_URL,
  buildAutocompleteRequest,
  buildChapterFallbackUrl,
  buildDirectoryUrl,
  buildLoadMoreRequest,
  buildMangaUrl,
  fetchJSON,
  fetchText,
  parseSeriesUrl,
} from "./network.js";

const originalApplication = globalThis.Application;

afterEach(() => {
  Object.assign(globalThis, { Application: originalApplication });
});

describe("Thunder network URLs", () => {
  it("builds complete deterministic directory filter URLs", () => {
    const query: SearchQuery<ThunderSearchMetadata> = {
      title: "",
      metadata: {
        genres: { "20": "excluded", "10": "included", "30": "included" },
        status: ["ongoing"],
        type: ["manhwa"],
      },
    };
    const sorting: SortingOption = { id: "popular", label: "Most popular" };

    assert.equal(
      buildDirectoryUrl(query, sorting, 3),
      "https://en-thunderscans.com/comics/?page=3&genre%5B%5D=10&genre%5B%5D=30&status=ongoing&type=manhwa&order=popular",
    );
  });

  it("uses WordPress title-search pagination without ineffective advanced filters", () => {
    assert.equal(
      buildDirectoryUrl(
        {
          title: "  storm   architect  ",
          metadata: { status: ["completed"], type: ["novel"] },
        },
        { id: "title", label: "Title" },
        2,
      ),
      "https://en-thunderscans.com/comics/page/2/?s=storm%20architect",
    );
  });

  it("accepts only canonical first-party series URLs", () => {
    assert.equal(
      parseSeriesUrl("https://en-thunderscans.com/comics/storm%20architect/?from=app"),
      "storm architect",
    );
    assert.equal(parseSeriesUrl("https://www.en-thunderscans.com/comics/title/"), undefined);
    assert.equal(parseSeriesUrl("https://en-thunderscans.com.evil.test/comics/title/"), undefined);
    assert.equal(parseSeriesUrl("https://en-thunderscans.com/title-chapter-1/"), undefined);
  });

  it("preserves legacy numeric manga IDs and builds a safe chapter fallback", () => {
    assert.equal(buildMangaUrl("4242"), "https://en-thunderscans.com/?p=4242");
    assert.equal(
      buildMangaUrl("storm architect"),
      "https://en-thunderscans.com/comics/storm%20architect/",
    );
    assert.equal(
      buildChapterFallbackUrl("storm-architect", "2.5"),
      "https://en-thunderscans.com/storm-architect-chapter-2-5/",
    );
    assert.equal(buildChapterFallbackUrl("../evil", "2"), undefined);
  });

  it("builds encoded AJAX requests for autocomplete and both home feeds", () => {
    assert.deepEqual(buildAutocompleteRequest("storm & rain"), {
      url: AJAX_URL,
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8" },
      body: "action=ts_ac_do_search&ts_ac_query=storm%20%26%20rain",
    });
    assert.equal(
      buildLoadMoreRequest("latestComics", 2).body,
      "action=load_more_manga_posts&page=2",
    );
    assert.equal(
      buildLoadMoreRequest("latestNovels", 3).body,
      "action=load_more_novel_posts&novel_page=3",
    );
  });
});

describe("Thunder response handling", () => {
  const install = (status: number, body: string): Request[] => {
    const requests: Request[] = [];
    Object.assign(globalThis, {
      Application: {
        arrayBufferToUTF8String: (buffer: ArrayBuffer) => new TextDecoder().decode(buffer),
        scheduleRequest: async (request: Request): Promise<[Response, ArrayBuffer]> => {
          requests.push(request);
          return [
            { url: request.url, status, headers: {}, cookies: [] },
            new TextEncoder().encode(body).buffer,
          ];
        },
      },
    });
    return requests;
  };

  it("returns text and parsed JSON for successful responses", async () => {
    install(200, '{"ok":true}');
    const request = { url: "https://en-thunderscans.com/", method: "GET" };

    assert.equal(await fetchText(request), '{"ok":true}');
    assert.deepEqual(await fetchJSON(request), { ok: true });
  });

  it("surfaces useful status failures without echoing whole HTML bodies", async () => {
    for (const [status, message] of [
      [401, /sign in/i],
      [404, /not found/i],
      [429, /wait/i],
      [500, /status 500/i],
    ] as const) {
      install(status, `<html>${"private detail ".repeat(100)}</html>`);
      await assert.rejects(
        fetchText({ url: "https://en-thunderscans.com/private", method: "GET" }),
        message,
      );
    }
  });

  it("reports malformed JSON with URL context", async () => {
    install(200, "not-json");
    await assert.rejects(
      fetchJSON({ url: "https://en-thunderscans.com/ajax", method: "POST" }),
      /parse JSON.*\/ajax/i,
    );
  });
});
