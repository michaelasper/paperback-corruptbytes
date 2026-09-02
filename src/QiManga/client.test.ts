import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { Request, Response } from "@paperback/types";

import { QiMangaClient } from "./client.js";
import { API_BASE_URL, seriesSlugToId } from "./network.js";
import {
  CHAPTER_PAGE_ONE,
  CHAPTER_PAGE_TWO,
  COMIC_CHAPTER_RESPONSE,
  GENRES_RESPONSE,
  HOME_RESPONSE,
  LATEST_RESPONSE,
  LOCKED_CHAPTER_RESPONSE,
  NOVEL_CHAPTER_RESPONSE,
  NOVEL_DETAIL,
  SEARCH_RESPONSE,
  SERIES_DETAIL,
} from "./test-fixtures.js";

const originalApplication = globalThis.Application;
let requests: Request[] = [];
let responseStatus = 200;
let seriesResponse: unknown = SERIES_DETAIL;
let latestPageOverride: number | undefined;
let chapterPageOne: unknown = CHAPTER_PAGE_ONE;
let chapterPageTwo: unknown = CHAPTER_PAGE_TWO;

const responseFor = (request: Request): unknown => {
  const url = new URL(request.url);
  const pathname = decodeURIComponent(url.pathname);
  if (pathname.endsWith("/home")) return HOME_RESPONSE;
  if (pathname.endsWith("/home/latest")) {
    return {
      ...LATEST_RESPONSE,
      current: latestPageOverride ?? Number(url.searchParams.get("page") ?? 1),
    };
  }
  if (pathname.endsWith("/series/genres")) return GENRES_RESPONSE;
  if (pathname.endsWith("/series/search")) return SEARCH_RESPONSE;
  if (pathname.endsWith("/chapters/chapter-3")) return COMIC_CHAPTER_RESPONSE;
  if (pathname.endsWith("/chapters/chapter-32")) return NOVEL_CHAPTER_RESPONSE;
  if (pathname.endsWith("/chapters/chapter-52")) return LOCKED_CHAPTER_RESPONSE;
  if (pathname.endsWith("/chapters")) {
    return url.searchParams.get("page") === "2" ? chapterPageTwo : chapterPageOne;
  }
  if (pathname.endsWith("/series/i'm-a-soldier-in-america")) return NOVEL_DETAIL;
  if (/\/series\/[^/]+$/.test(pathname)) return seriesResponse;
  if (pathname.endsWith("/series")) return LATEST_RESPONSE;
  throw new Error(`Unexpected test URL: ${request.url}`);
};

beforeEach(() => {
  requests = [];
  responseStatus = 200;
  seriesResponse = SERIES_DETAIL;
  latestPageOverride = undefined;
  chapterPageOne = CHAPTER_PAGE_ONE;
  chapterPageTwo = CHAPTER_PAGE_TWO;
  Object.assign(globalThis, {
    Application: {
      arrayBufferToUTF8String: (buffer: ArrayBuffer) => new TextDecoder().decode(buffer),
      scheduleRequest: async (request: Request): Promise<[Response, ArrayBuffer]> => {
        requests.push(request);
        const body = JSON.stringify(responseFor(request));
        return [
          { url: request.url, status: responseStatus, headers: {}, cookies: [] },
          new TextEncoder().encode(body).buffer,
        ];
      },
    },
  });
});

afterEach(() => Object.assign(globalThis, { Application: originalApplication }));

describe("Qi Manga client caching", () => {
  it("evicts a cached series document when mapping fails", async () => {
    const client = new QiMangaClient();
    seriesResponse = { slug: SERIES_DETAIL.slug, title: "" };

    await assert.rejects(
      client.getMangaDetails(seriesSlugToId(SERIES_DETAIL.slug)),
      /invalid series detail/i,
    );

    seriesResponse = SERIES_DETAIL;
    const manga = await client.getMangaDetails(seriesSlugToId(SERIES_DETAIL.slug));
    assert.equal(manga.mangaInfo.primaryTitle, SERIES_DETAIL.title);
    assert.equal(
      requests.filter((request) => request.url.endsWith(`/series/${SERIES_DETAIL.slug}`)).length,
      2,
    );
  });

  it("coalesces raw documents while returning fresh parsed objects", async () => {
    const client = new QiMangaClient();
    const [first, second] = await Promise.all([client.getHome(), client.getHome()]);
    assert.equal(requests.filter((request) => request.url.endsWith("/home")).length, 1);
    assert.notEqual(first, second);
    first.banners[0]!.title = "mutated";
    assert.equal(second.banners[0]?.title, HOME_RESPONSE.banners[0].title);

    const [firstGenres, secondGenres] = await Promise.all([client.getGenres(), client.getGenres()]);
    assert.deepEqual(firstGenres, secondGenres);
    assert.notEqual(firstGenres, secondGenres);
    assert.equal(requests.filter((request) => request.url.endsWith("/series/genres")).length, 1);
  });
});

describe("Qi Manga client catalog", () => {
  it("uses title search only when a title is present", async () => {
    const client = new QiMangaClient();
    await client.getSearchPage(
      { title: "demon", metadata: { status: "ONGOING" } },
      { id: "popular", label: "Popular" },
      1,
    );
    await client.getSearchPage(
      { title: "", metadata: { genre: "action", status: "ONGOING" } },
      { id: "popular", label: "Popular" },
      1,
    );

    const search = requests.find((request) => request.url.includes("/series/search"));
    const browse = requests.find(
      (request) => request.url.includes("/series?") && !request.url.includes("/series/search"),
    );
    assert.match(search?.url ?? "", /q=demon/);
    assert.doesNotMatch(search?.url ?? "", /status=/);
    assert.match(browse?.url ?? "", /genre=action/);
    assert.match(browse?.url ?? "", /status=ONGOING/);
    assert.match(browse?.url ?? "", /sort=popular/);
  });

  it("resolves pasted first-party URLs into one detailed result", async () => {
    const client = new QiMangaClient();
    const result = await client.resolvePastedUrl(
      "https://qimanga.com/series/the-supreme-demon-swordmaster?ref=paperback",
    );
    assert.equal(result?.items[0]?.mangaId, "the-supreme-demon-swordmaster");
    assert.equal(result?.items[0]?.title, SERIES_DETAIL.title);
    assert.equal(await client.resolvePastedUrl("https://evil.test/series/title"), undefined);
  });

  it("suppresses only missing pasted titles and propagates operational failures", async () => {
    const client = new QiMangaClient();
    const url = "https://qimanga.com/series/the-supreme-demon-swordmaster";
    responseStatus = 404;
    assert.equal(await client.resolvePastedUrl(url), undefined);

    responseStatus = 503;
    await assert.rejects(new QiMangaClient().resolvePastedUrl(url), /status 503/i);
  });

  it("loads paginated latest results with the server's page metadata", async () => {
    const page = await new QiMangaClient().getLatest(2);
    assert.equal(page.page, 2);
    assert.equal(page.pageCount, 2);
    assert.equal(page.items.length, 2);
  });

  it("rejects and evicts a catalog response for a different requested page", async () => {
    const client = new QiMangaClient();
    latestPageOverride = 1;
    await assert.rejects(client.getLatest(2), /wrong catalog page/i);
    latestPageOverride = undefined;
    assert.equal((await client.getLatest(2)).page, 2);
    assert.equal(requests.filter((request) => request.url.includes("/home/latest")).length, 2);
  });
});

describe("Qi Manga client chapters", () => {
  it("loads every page in order and reuses raw pages for locked visibility", async () => {
    const client = new QiMangaClient();
    const manga = await client.getMangaDetails(seriesSlugToId(SERIES_DETAIL.slug));
    const all = await client.getChapters(manga, { showLocked: true });
    const free = await client.getChapters(manga, { showLocked: false });
    const malformed = await client.getChapters(manga, {
      showLocked: "false" as unknown as boolean,
    });

    assert.deepEqual(
      all.map((chapter) => chapter.chapNum),
      [1, 2.5, 3, 4],
    );
    assert.deepEqual(
      free.map((chapter) => chapter.chapNum),
      [1, 3],
    );
    assert.deepEqual(
      malformed.map((chapter) => chapter.chapNum),
      [1, 2.5, 3, 4],
    );
    assert.equal(requests.filter((request) => /\/chapters\?/.test(request.url)).length, 2);

    client.invalidateAccountCaches();
    await client.getChapters(manga, { showLocked: true });
    assert.equal(requests.filter((request) => /\/chapters\?/.test(request.url)).length, 4);
  });

  it("keeps chapters without dates while filtering known dates incrementally", async () => {
    const client = new QiMangaClient();
    const manga = await client.getMangaDetails(seriesSlugToId(SERIES_DETAIL.slug));
    const chapters = await client.getChapters(manga, {
      showLocked: true,
      sinceDate: new Date("2026-01-02T18:00:00.000Z"),
    });
    assert.deepEqual(
      chapters.map((chapter) => chapter.chapNum),
      [3, 4],
    );

    class MisleadingDate extends Date {
      override getTime(): number {
        return new Date("9999-01-01T00:00:00.000Z").getTime();
      }
    }
    const misleadingDate = new MisleadingDate("2026-01-02T18:00:00.000Z");
    assert.deepEqual(
      (
        await client.getChapters(manga, {
          showLocked: true,
          sinceDate: misleadingDate,
        })
      ).map((chapter) => chapter.chapNum),
      [3, 4],
    );

    for (const malformedDate of [new Date(Number.NaN), new Proxy(new Date(), {}) as Date]) {
      assert.deepEqual(
        (
          await client.getChapters(manga, {
            showLocked: true,
            sinceDate: malformedDate,
          })
        ).map((chapter) => chapter.chapNum),
        [1, 2.5, 3, 4],
      );
    }
  });

  it("rejects wrong pages, oversized pagination, and truncated complete lists", async () => {
    const client = new QiMangaClient();
    const manga = await client.getMangaDetails(seriesSlugToId(SERIES_DETAIL.slug));

    chapterPageOne = { ...CHAPTER_PAGE_ONE, current: 2 };
    await assert.rejects(client.getChapters(manga), /wrong chapter page/i);

    client.invalidateAccountCaches();
    chapterPageOne = CHAPTER_PAGE_ONE;
    chapterPageTwo = { ...CHAPTER_PAGE_TWO, current: 1 };
    await assert.rejects(client.getChapters(manga), /wrong chapter page/i);

    client.invalidateAccountCaches();
    chapterPageTwo = { ...CHAPTER_PAGE_TWO, totalPages: 3 };
    await assert.rejects(client.getChapters(manga), /inconsistent declared chapter pagination/i);

    client.invalidateAccountCaches();
    chapterPageOne = { ...CHAPTER_PAGE_ONE, totalPages: 101 };
    await assert.rejects(client.getChapters(manga), /too many chapter pages/i);

    client.invalidateAccountCaches();
    chapterPageOne = { ...CHAPTER_PAGE_ONE, totalPages: 100, totalItems: 10_001 };
    await assert.rejects(client.getChapters(manga), /too many chapters/i);

    client.invalidateAccountCaches();
    chapterPageOne = { ...CHAPTER_PAGE_ONE, totalItems: 5 };
    chapterPageTwo = { ...CHAPTER_PAGE_TWO, totalItems: 5 };
    await assert.rejects(client.getChapters(manga), /only 4 of 5 chapters/i);

    client.invalidateAccountCaches();
    chapterPageOne = { ...CHAPTER_PAGE_ONE, totalItems: 4 };
    chapterPageTwo = { ...CHAPTER_PAGE_TWO, totalItems: 5 };
    await assert.rejects(client.getChapters(manga), /inconsistent declared chapter totals/i);

    client.invalidateAccountCaches();
    const locked = CHAPTER_PAGE_ONE.data[1];
    chapterPageOne = {
      data: [locked, { ...locked, id: 99 }],
      totalItems: 2,
      totalPages: 1,
      current: 1,
      next: null,
    };
    await assert.rejects(client.getChapters(manga, { showLocked: false }), /only 1 of 2 chapters/i);

    client.invalidateAccountCaches();
    chapterPageOne = { ...CHAPTER_PAGE_ONE, totalItems: 2 };
    chapterPageTwo = { ...CHAPTER_PAGE_TWO, totalItems: 2 };
    await assert.rejects(client.getChapters(manga), /distinct chapters.*declared total/i);
  });

  it("rejects stale chapter responses and partitions caches across account changes", async () => {
    const manga = await new QiMangaClient().getMangaDetails(seriesSlugToId(SERIES_DETAIL.slug));
    const onePage = JSON.stringify({
      ...CHAPTER_PAGE_ONE,
      data: [CHAPTER_PAGE_ONE.data[0]],
      totalItems: 1,
      totalPages: 1,
      next: null,
    });
    let authenticationGeneration = 0;
    let calls = 0;
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const client = new QiMangaClient(
      async () => {
        calls += 1;
        if (calls === 1) {
          markFirstStarted();
          await firstGate;
        }
        return onePage;
      },
      () => authenticationGeneration,
    );

    const stale = client.getChapters(manga, { showLocked: true });
    await firstStarted;
    authenticationGeneration += 1;
    releaseFirst();
    await assert.rejects(stale, /authentication changed/i);

    assert.equal((await client.getChapters(manga, { showLocked: true })).length, 1);
    assert.equal(calls, 2);
    authenticationGeneration += 1;
    assert.equal((await client.getChapters(manga, { showLocked: true })).length, 1);
    assert.equal(calls, 3);
  });

  it("fails closed when the authentication generation callback is malformed", async () => {
    const manga = await new QiMangaClient().getMangaDetails(seriesSlugToId(SERIES_DETAIL.slug));
    for (const generation of [Number.NaN, -1, 1.5]) {
      let calls = 0;
      const client = new QiMangaClient(
        async () => {
          calls += 1;
          return JSON.stringify(CHAPTER_PAGE_ONE);
        },
        () => generation,
      );
      await assert.rejects(client.getChapters(manga), /authentication changed/i);
      assert.equal(calls, 0);
    }
    const throwing = new QiMangaClient(
      async () => JSON.stringify(CHAPTER_PAGE_ONE),
      () => {
        throw new Error("private generation failure");
      },
    );
    await assert.rejects(throwing.getChapters(manga), /authentication changed/i);
  });

  it("returns comic and novel readers and preserves server-side paid locks", async () => {
    const client = new QiMangaClient();
    const manga = await client.getMangaDetails(seriesSlugToId(SERIES_DETAIL.slug));
    const novel = await client.getMangaDetails(seriesSlugToId(NOVEL_DETAIL.slug));

    const comicDetails = await client.getChapterDetails({
      chapterId: "chapter-3",
      sourceManga: manga,
      langCode: "en",
      chapNum: 3,
    });
    assert.ok("pages" in comicDetails);

    const novelDetails = await client.getChapterDetails({
      chapterId: "chapter-32",
      sourceManga: novel,
      langCode: "en",
      chapNum: 32,
    });
    assert.ok("html" in novelDetails);

    await assert.rejects(
      client.getChapterDetails({
        chapterId: "chapter-52",
        sourceManga: manga,
        langCode: "en",
        chapNum: 52,
        additionalInfo: { locked: "true" },
      }),
      /still locked/i,
    );
    const readerRequests = requests.filter((request) => /\/chapters\/chapter-/.test(request.url));
    assert.ok(readerRequests.every((request) => request.headers?.["cache-control"] === "no-store"));
  });
});

describe("Qi Manga client response consistency", () => {
  it("uses only the configured API origin", async () => {
    const client = new QiMangaClient();
    await client.getHome();
    await client.getGenres();
    assert.ok(requests.every((request) => request.url.startsWith(API_BASE_URL)));
  });
});
