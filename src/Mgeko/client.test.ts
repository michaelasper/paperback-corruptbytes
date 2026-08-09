import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { Request, Response } from "@paperback/types";

import { MgekoClient } from "./client.js";
import {
  BROWSE_FILTER_HTML,
  BROWSE_RESULTS_HTML,
  CHAPTERS_HTML,
  READER_HTML,
  SERIES_HTML,
} from "./test-fixtures.js";

const originalApplication = globalThis.Application;
let requests: Request[] = [];

beforeEach(() => {
  requests = [];
  Object.assign(globalThis, {
    Application: {
      arrayBufferToUTF8String: (buffer: ArrayBuffer) => new TextDecoder().decode(buffer),
      scheduleRequest: async (request: Request): Promise<[Response, ArrayBuffer]> => {
        requests.push(request);
        let body = "";
        if (request.url.includes("browse-comics/data")) {
          body = JSON.stringify({
            results_html: BROWSE_RESULTS_HTML,
            page: 1,
            num_pages: 2,
            total_results: 30,
          });
        } else if (request.url.endsWith("/browse-comics/")) body = BROWSE_FILTER_HTML;
        else if (request.url.includes("/all-chapters/")) body = CHAPTERS_HTML;
        else if (request.url.includes("/reader/en/")) body = READER_HTML;
        else if (request.url.includes("/manga/")) body = SERIES_HTML;
        return [
          { url: request.url, status: 200, headers: {}, cookies: [] },
          new TextEncoder().encode(body).buffer,
        ];
      },
    },
  });
});

afterEach(() => Object.assign(globalThis, { Application: originalApplication }));

describe("Mgeko client", () => {
  it("coalesces reusable documents while returning fresh parsed objects", async () => {
    const client = new MgekoClient();
    const [firstFilters, secondFilters] = await Promise.all([
      client.getFilterOptions(),
      client.getFilterOptions(),
    ]);
    assert.deepEqual(firstFilters, secondFilters);
    assert.equal(requests.filter((request) => request.url.endsWith("/browse-comics/")).length, 1);

    const [first, second] = await Promise.all([
      client.getMangaDetails("dark-%7E-mage"),
      client.getMangaDetails("dark-%7E-mage"),
    ]);
    assert.notEqual(first, second);
    assert.equal(
      requests.filter((request) => request.url.includes("/manga/dark-~-mage/")).length,
      1,
    );
  });

  it("uses exact archived IDs for chapter lists and readers", async () => {
    const client = new MgekoClient();
    const manga = await client.getMangaDetails("dark-%7E-mage");
    const chapters = await client.getChapters(manga);
    const selected = chapters.at(-1)!;
    const details = await client.getChapterDetails(selected);

    assert.equal(selected.chapterId, "dark-%7E-mage-chapter-21-1-eng-li");
    assert.ok("pages" in details && details.pages.length === 2);
    assert.ok(requests.some((request) => request.url.includes("dark-~-mage-chapter-21-1-eng-li")));
  });

  it("searches through the safe browse API and resolves pasted series URLs", async () => {
    const client = new MgekoClient();
    const page = await client.getBrowsePage(
      { title: "dark mage" },
      { id: "rating", label: "Top rated" },
      1,
      true,
    );
    const pasted = await client.resolvePastedUrl("https://www.mgeko.cc/manga/dark-~-mage/");

    assert.equal(page.items[0]?.mangaId, "dark-%7E-mage");
    assert.equal(pasted?.items[0]?.mangaId, "dark-%7E-mage");
    assert.match(requests[0]?.url ?? "", /q=dark%20mage.*safe_mode=1/);
  });
});
