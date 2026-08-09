import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import type { Request, Response } from "@paperback/types";

import {
  buildBrowseUrl,
  buildChapterUrl,
  buildMangaUrl,
  fetchJson,
  fetchText,
  parseMangaUrl,
} from "./network.js";

const originalApplication = globalThis.Application;

afterEach(() => Object.assign(globalThis, { Application: originalApplication }));

describe("Mgeko network contracts", () => {
  it("builds one complete paginated query for title search and every live filter", () => {
    assert.equal(
      buildBrowseUrl(
        {
          title: "  dark   mage  ",
          metadata: {
            genres: { Action: "included", Mature: "excluded" },
            status: ["ongoing"],
            type: ["manhwa"],
            tags: "regression, sword-master",
            setChapterCount: true,
            minChapters: 10,
            maxChapters: 125,
            minRating: 4.2,
            onlyCompleted: true,
            onlyTranslated: true,
            hideOnBreak: true,
          },
        },
        { id: "popular_weekly", label: "Popular weekly" },
        3,
        false,
      ),
      "https://www.mgeko.cc/browse-comics/data/?page=3&sort=popular_weekly&q=dark%20mage&include_genres=Action&exclude_genres=Mature&status=ongoing&type=manhwa&tags=regression%2Csword-master&min_chapters=10&max_chapters=125&min_rating=42&only_completed=1&only_translated=1&hide_on_break=1&safe_mode=0",
    );
  });

  it("preserves archived safe IDs, decodes unsafe IDs for routes, and parses pasted URLs", () => {
    assert.equal(
      buildMangaUrl("the-reincarnated-assassin-is-a-genius-swordsman"),
      "https://www.mgeko.cc/manga/the-reincarnated-assassin-is-a-genius-swordsman/",
    );
    assert.equal(buildMangaUrl("dark-%7E-mage"), "https://www.mgeko.cc/manga/dark-~-mage/");
    assert.equal(
      buildChapterUrl("dark-%7E-mage-chapter-21-1-eng-li"),
      "https://www.mgeko.cc/reader/en/dark-~-mage-chapter-21-1-eng-li/",
    );
    assert.equal(
      parseMangaUrl("https://mgeko.cc/manga/dark-~-mage/?from=paperback"),
      "dark-%7E-mage",
    );
    assert.equal(parseMangaUrl("https://mgeko.cc.evil.test/manga/dark-mage/"), undefined);
  });
});

describe("Mgeko response handling", () => {
  const install = (status: number, body: string, responseUrl?: string): Request[] => {
    const requests: Request[] = [];
    Object.assign(globalThis, {
      Application: {
        arrayBufferToUTF8String: (buffer: ArrayBuffer) => new TextDecoder().decode(buffer),
        scheduleRequest: async (request: Request): Promise<[Response, ArrayBuffer]> => {
          requests.push(request);
          return [
            { url: responseUrl ?? request.url, status, headers: {}, cookies: [] },
            new TextEncoder().encode(body).buffer,
          ];
        },
      },
    });
    return requests;
  };

  it("returns text and rejects malformed JSON with bounded source context", async () => {
    install(200, "plain text");
    assert.equal(await fetchText({ url: "https://www.mgeko.cc/", method: "GET" }), "plain text");
    await assert.rejects(
      fetchJson({
        url: "https://www.mgeko.cc/browse-comics/data/\u0000?token=secret#fragment",
        method: "GET",
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /Mgeko.*JSON.*browse-comics/i);
        assert.doesNotMatch(error.message, /token=secret|fragment/i);
        assert.equal(error.message.includes("\u0000"), false);
        return true;
      },
    );
  });

  it("rejects foreign initial requests and redirected responses before decoding", async () => {
    const initialRequests = install(200, "private");
    await assert.rejects(
      fetchText({ url: "https://evil.example/metadata", method: "GET" }),
      /response URL was not trusted/i,
    );
    assert.equal(initialRequests.length, 0);

    let decodeCalls = 0;
    install(200, "private", "https://evil.example/redirected");
    Object.assign(globalThis.Application, {
      arrayBufferToUTF8String: () => {
        decodeCalls += 1;
        return "private";
      },
    });
    await assert.rejects(
      fetchText({ url: "https://www.mgeko.cc/metadata", method: "GET" }),
      /response URL was not trusted/i,
    );
    assert.equal(decodeCalls, 0);
  });

  it("rejects oversized responses before decoding them", async () => {
    let decodeCalls = 0;
    install(200, "x".repeat(8 * 1_024 * 1_024 + 1));
    Object.assign(globalThis.Application, {
      arrayBufferToUTF8String: (buffer: ArrayBuffer) => {
        decodeCalls += 1;
        return new TextDecoder().decode(buffer);
      },
    });

    await assert.rejects(
      fetchText({ url: "https://www.mgeko.cc/api?token=secret", method: "GET" }),
      /Mgeko.*too large/i,
    );
    assert.equal(decodeCalls, 0);
  });

  it("maps useful HTTP failures without leaking response bodies", async () => {
    for (const [status, message] of [
      [404, /not found/i],
      [429, /wait/i],
      [500, /status 500/i],
    ] as const) {
      install(status, "private ".repeat(1_000));
      await assert.rejects(
        fetchText({ url: "https://www.mgeko.cc/private?token=secret", method: "GET" }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, message);
          assert.doesNotMatch(error.message, /private |token=secret/i);
          return true;
        },
      );
    }
  });
});
