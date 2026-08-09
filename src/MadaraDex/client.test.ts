import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { ContentRating, type Chapter, type Request, type Response } from "@paperback/types";

import { MadaraDexClient } from "./client.js";
import {
  DIRECTORY_HTML,
  FILTERS_HTML,
  READER_HTML,
  SEARCH_HTML,
  SERIES_HTML,
} from "./test-fixtures.js";

const originalApplication = globalThis.Application;
let requests: Request[];
let seriesHtml: string;

const text = (value: string): ArrayBuffer => new TextEncoder().encode(value).buffer;

beforeEach(() => {
  requests = [];
  seriesHtml = SERIES_HTML;
  Object.assign(globalThis, {
    Application: {
      arrayBufferToUTF8String: (buffer: ArrayBuffer) => new TextDecoder().decode(buffer),
      scheduleRequest: async (request: Request): Promise<[Response, ArrayBuffer]> => {
        requests.push(request);
        if (request.url.includes("wp-admin/admin-ajax.php")) {
          return [
            { url: request.url, status: 200, headers: {}, cookies: [] },
            text(
              '<li class="wp-manga-chapter"><a href="/title/savage-hero/chapter-3/">Chapter 3</a></li>',
            ),
          ];
        }
        if (request.url.includes("chapter-")) {
          return [{ url: request.url, status: 200, headers: {}, cookies: [] }, text(READER_HTML)];
        }
        if (request.url.includes("?p=2872") || request.url.includes("/title/savage-hero/")) {
          return [
            {
              url: "https://madaradex.org/title/savage-hero/",
              status: 200,
              headers: {},
              cookies: [],
            },
            text(seriesHtml),
          ];
        }
        if (request.url.includes("s=&post_type=wp-manga")) {
          return [{ url: request.url, status: 200, headers: {}, cookies: [] }, text(FILTERS_HTML)];
        }
        if (request.url.includes("s=magic")) {
          return [{ url: request.url, status: 200, headers: {}, cookies: [] }, text(SEARCH_HTML)];
        }
        return [{ url: request.url, status: 200, headers: {}, cookies: [] }, text(DIRECTORY_HTML)];
      },
    },
  });
});

afterEach(() => Object.assign(globalThis, { Application: originalApplication }));

describe("MadaraDex client", () => {
  it("evicts a cached series document when parsing fails", async () => {
    const client = new MadaraDexClient();
    seriesHtml = "<html><body><main>temporary shape</main></body></html>";

    await assert.rejects(client.getMangaDetails("2872"), /series title/);

    seriesHtml = SERIES_HTML;
    assert.equal((await client.getMangaDetails("2872")).mangaId, "2872");
    assert.equal(requests.filter((request) => request.url.includes("?p=2872")).length, 2);
  });

  it("coalesces reusable documents while returning fresh parsed objects", async () => {
    const client = new MadaraDexClient();
    const [first, second] = await Promise.all([
      client.getMangaDetails("2872"),
      client.getMangaDetails("2872"),
    ]);
    assert.deepEqual(first, second);
    assert.notEqual(first, second);
    assert.equal(requests.filter((request) => request.url.includes("?p=2872")).length, 1);

    const [firstFilters, secondFilters] = await Promise.all([
      client.getFilterOptions(),
      client.getFilterOptions(),
    ]);
    assert.deepEqual(firstFilters, secondFilters);
    assert.equal(
      requests.filter((request) => request.url.includes("s=&post_type=wp-manga")).length,
      1,
    );
  });

  it("uses inline chapters first and falls back across both Madara AJAX contracts", async () => {
    const client = new MadaraDexClient();
    const manga = await client.getMangaDetails("2872");
    assert.equal((await client.getChapters(manga)).length, 3);
    assert.equal(requests.filter((request) => request.url.includes("admin-ajax")).length, 0);

    client.invalidateCaches();
    seriesHtml = SERIES_HTML.replace(/<ul class="main version-chap">[\s\S]*?<\/ul>/, "");
    const fallback = await client.getChapters(await client.getMangaDetails("2872"));
    assert.equal(fallback[0]?.chapterId, "chapter-3");
    assert.equal(requests.filter((request) => request.url.includes("admin-ajax")).length, 1);
  });

  it("recovers reader URLs for archived chapters that predate additionalInfo", async () => {
    const client = new MadaraDexClient();
    const sourceManga = {
      mangaId: "2872",
      mangaInfo: {
        primaryTitle: "Savage Hero",
        secondaryTitles: [],
        thumbnailUrl: "https://madaradex.org/cover.webp",
        synopsis: "",
        contentRating: ContentRating.ADULT,
      },
    };
    const archived: Chapter = {
      chapterId: "chapter-2",
      sourceManga,
      langCode: "en",
      chapNum: 2,
    };
    const details = await client.getChapterDetails(archived);
    assert.ok("pages" in details && details.pages.length === 2);
    assert.ok(requests.some((request) => request.url.endsWith("/title/savage-hero/chapter-2/")));
  });

  it("reconstructs a removed archived chapter only from a trusted canonical share URL", async () => {
    const client = new MadaraDexClient();
    seriesHtml = SERIES_HTML.replace(/<ul class="main version-chap">[\s\S]*?<\/ul>/, "");
    const sourceManga = {
      mangaId: "2872",
      mangaInfo: {
        primaryTitle: "Savage Hero",
        secondaryTitles: [],
        thumbnailUrl: "https://madaradex.org/cover.webp",
        synopsis: "",
        contentRating: ContentRating.ADULT,
        shareUrl: "https://madaradex.org/title/savage-hero/",
      },
    };
    const archived: Chapter = {
      chapterId: "chapter-77",
      sourceManga,
      langCode: "en",
      chapNum: 77,
    };

    assert.ok("pages" in (await client.getChapterDetails(archived)));
    assert.ok(requests.some((request) => request.url.endsWith("/title/savage-hero/chapter-77/")));
  });

  it("resolves numeric and canonical pasted URLs while preserving the numeric source ID", async () => {
    const client = new MadaraDexClient();
    const numeric = await client.resolvePastedUrl("https://madaradex.org/?p=2872");
    const canonical = await client.resolvePastedUrl("https://madaradex.org/title/savage-hero/");
    assert.equal(numeric?.items[0]?.mangaId, "2872");
    assert.equal(canonical?.items[0]?.mangaId, "2872");
  });

  it("parses paged directory and search results through the same stable-card contract", async () => {
    const client = new MadaraDexClient();
    const directory = await client.getCatalogPage(
      { title: "" },
      { id: "latest", label: "Latest" },
      1,
    );
    const search = await client.getCatalogPage(
      { title: "magic" },
      { id: "relevance", label: "Relevance" },
      1,
    );
    assert.equal(directory.items[0]?.mangaId, "574");
    assert.equal(directory.hasNextPage, true);
    assert.equal(search.items[0]?.mangaId, "2947");
  });
});
