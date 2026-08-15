import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import type { Request, Response } from "@paperback/types";

import { NovelDashClient } from "./noveldash-client.js";
import { buildNovelDashSeriesUrl } from "./noveldash-network.js";
import {
  COMIC_MANGA_ID,
  NOVELDASH_TEST_SITE,
  comicReaderHtml,
  seriesChapter,
  seriesPageHtml,
} from "./noveldash-test-fixtures.js";

const originalApplication = globalThis.Application;

const installApplication = (responses: ReadonlyMap<string, string>): Request[] => {
  const requests: Request[] = [];
  Object.assign(globalThis, {
    Application: {
      arrayBufferToUTF8String: (buffer: ArrayBuffer) => new TextDecoder().decode(buffer),
      scheduleRequest: async (request: Request): Promise<[Response, ArrayBuffer]> => {
        requests.push(request);
        const body = responses.get(request.url);
        return [
          {
            url: request.url,
            status: body === undefined ? 404 : 200,
            headers: { "content-type": "text/html" },
            cookies: [],
          },
          new TextEncoder().encode(body ?? "Not found").buffer,
        ];
      },
    },
  });
  return requests;
};

afterEach(() => {
  Object.assign(globalThis, { Application: originalApplication });
});

describe("NovelDashClient chapter pagination", () => {
  it("walks every 100-chapter page without using the misleading internal slug", async () => {
    const pageOne = Array.from({ length: 100 }, (_, index) => seriesChapter(index + 1));
    const pageTwo = Array.from({ length: 5 }, (_, index) => seriesChapter(index + 101));
    const firstUrl = buildNovelDashSeriesUrl(NOVELDASH_TEST_SITE, COMIC_MANGA_ID, 1);
    const secondUrl = buildNovelDashSeriesUrl(NOVELDASH_TEST_SITE, COMIC_MANGA_ID, 2);
    const readerUrl = `${NOVELDASH_TEST_SITE.domain}/series/comic/route-slug/chapter/1`;
    const requests = installApplication(
      new Map([
        [
          firstUrl,
          seriesPageHtml({
            page: 1,
            totalPages: 2,
            chapterCount: 105,
            chapters: pageOne,
          }),
        ],
        [
          secondUrl,
          seriesPageHtml({
            page: 2,
            totalPages: 2,
            chapterCount: 105,
            chapters: pageTwo,
          }),
        ],
        [readerUrl, comicReaderHtml],
      ]),
    );
    const client = new NovelDashClient(NOVELDASH_TEST_SITE);
    const manga = await client.getMangaDetails(COMIC_MANGA_ID);
    const chapters = await client.getChapters(manga, { showLocked: true });

    assert.equal(chapters.length, 105);
    assert.equal(chapters[0]?.chapNum, 1);
    assert.equal(chapters.at(-1)?.chapNum, 105);
    assert.deepEqual(
      chapters.map((chapter) => chapter.sortingIndex),
      Array.from({ length: 105 }, (_, index) => index),
    );
    assert.equal(requests.filter((request) => request.url === firstUrl).length, 1);
    assert.equal(requests.filter((request) => request.url === secondUrl).length, 1);

    const reader = await client.getChapterDetails(chapters[0]!);
    assert.ok("pages" in reader && reader.pages.length === 2);
    assert.equal(requests.at(-1)?.url, readerUrl);
    assert.doesNotMatch(requests.at(-1)?.url ?? "", /reader-slug/);
  });

  it("fails explicitly instead of returning an incomplete chapter list", async () => {
    const firstUrl = buildNovelDashSeriesUrl(NOVELDASH_TEST_SITE, COMIC_MANGA_ID, 1);
    const secondUrl = buildNovelDashSeriesUrl(NOVELDASH_TEST_SITE, COMIC_MANGA_ID, 2);
    installApplication(
      new Map([
        [
          firstUrl,
          seriesPageHtml({
            page: 1,
            totalPages: 2,
            chapterCount: 106,
            chapters: Array.from({ length: 100 }, (_, index) => seriesChapter(index + 1)),
          }),
        ],
        [
          secondUrl,
          seriesPageHtml({
            page: 2,
            totalPages: 2,
            chapterCount: 106,
            chapters: Array.from({ length: 5 }, (_, index) => seriesChapter(index + 101)),
          }),
        ],
      ]),
    );
    const client = new NovelDashClient(NOVELDASH_TEST_SITE);
    const manga = await client.getMangaDetails(COMIC_MANGA_ID);

    await assert.rejects(
      client.getChapters(manga, { showLocked: true }),
      /only 105 of 106 chapters.*truncated/i,
    );
  });
});
