import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { QiMangaClient } from "./client.js";
import {
  buildBrowseUrl,
  buildChapterUrl,
  buildChaptersUrl,
  buildGenresUrl,
  buildHomeUrl,
  buildSearchUrl,
  buildSeriesUrl,
  seriesSlugToId,
} from "./network.js";
import {
  AUTH_REQUIRED_ERROR,
  LOCKED_ERROR,
  finalizeChapters,
  parseChapterDetails,
  parseChapterPage,
  parseGenres,
  parseHome,
  parseMangaDetails,
  parseSeriesPage,
} from "./parsers.js";

const live = process.env.QIMANGA_LIVE_TESTS === "1" ? it : it.skip;
const headers = {
  "user-agent": "Mozilla/5.0 PaperbackExtensionLiveContract/1.0",
  accept: "application/json,text/plain;q=0.9,*/*;q=0.8",
  origin: "https://qimanga.com",
  referer: "https://qimanga.com/",
};
const MAX_JSON_BYTES = 4 * 1_024 * 1_024;

const requestJson = async (url: string): Promise<unknown> => {
  const response = await fetch(url, {
    headers,
    redirect: "follow",
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(response.ok, true, `${response.status} from ${response.url}`);
  assert.equal(new URL(response.url).hostname, "api.qimanga.com");
  const data = await response.arrayBuffer();
  assert.ok(data.byteLength <= MAX_JSON_BYTES, `Oversized live JSON from ${new URL(url).pathname}`);
  return JSON.parse(new TextDecoder().decode(data)) as unknown;
};

describe("Qi Manga live public contract", () => {
  live("keeps every enabled home rail, taxonomy, and filtered novel browse live", async () => {
    const [homeResponse, genreResponse, novelResponse] = await Promise.all([
      requestJson(buildHomeUrl()),
      requestJson(buildGenresUrl()),
      requestJson(
        buildBrowseUrl(
          { title: "", metadata: { type: "NOVEL" } },
          { id: "latest", label: "Latest" },
          1,
        ),
      ),
    ]);
    const [titleResponse, filteredResponse, newestResponse, alphabeticalResponse] =
      await Promise.all([
        requestJson(buildSearchUrl({ title: "supreme demon swordmaster" }, 1)),
        requestJson(
          buildBrowseUrl(
            { title: "", metadata: { genre: "action", status: "ONGOING" } },
            { id: "popular", label: "Popular" },
            1,
          ),
        ),
        requestJson(buildBrowseUrl({ title: "" }, { id: "newest", label: "Newest" }, 1)),
        requestJson(buildBrowseUrl({ title: "" }, { id: "alphabetical", label: "Title: A–Z" }, 1)),
      ]);
    const home = parseHome(homeResponse);
    const genres = parseGenres(genreResponse);
    const novels = parseSeriesPage(novelResponse);
    const titleResults = parseSeriesPage(titleResponse);
    const filtered = parseSeriesPage(filteredResponse);
    const newest = parseSeriesPage(newestResponse);
    const alphabetical = parseSeriesPage(alphabeticalResponse);

    assert.ok(home.banners.length > 0);
    assert.ok(home.popular.length > 0);
    assert.ok(home.pinned.length > 0);
    assert.ok(home.newSeries.length > 0);
    assert.ok(home.editorsPick.length > 0);
    assert.ok(genres.length >= 20);
    assert.ok(genres.some((genre) => genre.id === "action"));
    assert.ok(novels.items.length > 0);
    assert.ok(novels.items.every((item) => item.type === "NOVEL"));
    assert.ok(novels.items.some((item) => item.mangaId.includes("%27")));
    assert.ok(titleResults.items.some((item) => item.mangaId === "the-supreme-demon-swordmaster"));
    assert.ok(filtered.items.length > 0);
    assert.ok(filtered.items.every((item) => item.status === "ONGOING"));
    assert.ok(newest.items.length > 0);
    assert.ok(alphabetical.items.length > 0);
  });

  live("preserves a comic ID, full chapter list, and ordered live image reader", async () => {
    const mangaId = "the-supreme-demon-swordmaster";
    const [detailResponse, chapterResponse] = await Promise.all([
      requestJson(buildSeriesUrl(mangaId)),
      requestJson(buildChaptersUrl(mangaId, 1, "asc")),
    ]);
    const manga = parseMangaDetails(detailResponse, mangaId);
    const chapterPage = parseChapterPage(chapterResponse, manga, true);
    const chapters = finalizeChapters(chapterPage.chapters);
    const first = chapters.find((chapter) => chapter.chapterId === "chapter-1");

    assert.equal(manga.mangaId, mangaId);
    assert.equal(manga.mangaInfo.contentType, "comic");
    assert.ok(chapters.length >= 50);
    assert.ok(first);
    const details = parseChapterDetails(
      await requestJson(buildChapterUrl(mangaId, first.chapterId)),
      first,
    );
    assert.ok("pages" in details && details.pages.length >= 10);
    if (!("pages" in details)) assert.fail("Expected an image chapter.");
    assert.equal(new Set(details.pages).size, details.pages.length);

    const imageResponse = await fetch(details.pages[0]!, {
      headers: { "user-agent": headers["user-agent"], range: "bytes=0-1023" },
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
    });
    assert.ok(imageResponse.ok || imageResponse.status === 206);
    assert.match(imageResponse.headers.get("content-type") ?? "", /^image\//);
    await imageResponse.body?.cancel();
  });

  live("loads a complete multi-page chapter history through the production client", async () => {
    let chapterPageRequests = 0;
    let declaredCount: number | undefined;
    let nextRequestSlot = Promise.resolve();
    const client = new QiMangaClient(async (request) => {
      const requestSlot = nextRequestSlot;
      nextRequestSlot = requestSlot.then(
        () => new Promise<void>((resolve) => setTimeout(resolve, 300)),
      );
      await requestSlot;
      const document = await requestJson(request.url);
      if (/\/chapters\?/.test(request.url)) {
        chapterPageRequests += 1;
        if (new URL(request.url).searchParams.get("page") === "1") {
          const candidate = (document as { totalItems?: unknown }).totalItems;
          if (typeof candidate === "number" && Number.isSafeInteger(candidate)) {
            declaredCount = candidate;
          }
        }
      }
      return JSON.stringify(document);
    });
    const manga = await client.getMangaDetails("martial-peak");
    const chapters = await client.getChapters(manga, { showLocked: true });

    assert.ok(chapterPageRequests > 1);
    assert.ok((declaredCount ?? 0) > 100);
    assert.equal(chapters.length, declaredCount);
    assert.equal(new Set(chapters.map((chapter) => chapter.chapterId)).size, chapters.length);
    assert.ok(
      chapters.every(
        (chapter, index) => index === 0 || chapter.chapNum >= chapters[index - 1]!.chapNum,
      ),
    );
  });

  live("keeps the legacy Quantum Scans image CDN readable", async () => {
    const mangaId = "465-days";
    const [detailResponse, chapterResponse] = await Promise.all([
      requestJson(buildSeriesUrl(mangaId)),
      requestJson(buildChaptersUrl(mangaId, 1, "asc")),
    ]);
    const manga = parseMangaDetails(detailResponse, mangaId);
    const chapter = parseChapterPage(chapterResponse, manga, true).chapters.find(
      (candidate) => candidate.chapterId === "chapter-1",
    );
    assert.ok(chapter);

    const details = parseChapterDetails(
      await requestJson(buildChapterUrl(mangaId, chapter.chapterId)),
      chapter,
    );
    assert.ok("pages" in details && details.pages.length > 0);
    if (!("pages" in details)) assert.fail("Expected a legacy image chapter.");
    assert.ok(details.pages.every((page) => new URL(page).hostname === "media.quantumscans.org"));
  });

  live("round-trips an apostrophe novel ID into sanitized live HTML", async () => {
    const slug = "i'm-a-soldier-in-america";
    const mangaId = seriesSlugToId(slug);
    const [detailResponse, chapterResponse] = await Promise.all([
      requestJson(buildSeriesUrl(mangaId)),
      requestJson(buildChaptersUrl(mangaId, 1, "asc")),
    ]);
    const manga = parseMangaDetails(detailResponse, mangaId);
    const chapters = finalizeChapters(parseChapterPage(chapterResponse, manga, true).chapters);
    const first = chapters.find((chapter) => chapter.chapterId === "chapter-1");

    assert.equal(mangaId, "i%27m-a-soldier-in-america");
    assert.equal(manga.mangaInfo.contentType, "novel");
    assert.ok(first);
    const details = parseChapterDetails(
      await requestJson(buildChapterUrl(mangaId, first.chapterId)),
      first,
    );
    assert.ok("html" in details && details.html.length > 1_000);
    if (!("html" in details)) assert.fail("Expected a novel chapter.");
    assert.doesNotMatch(details.html, /<script|<iframe|\son\w+=|javascript:/i);
  });

  live("honors the live account-specific access decision without fabricating pages", async () => {
    const mangaId = "the-supreme-demon-swordmaster";
    const [detailResponse, chapterResponse] = await Promise.all([
      requestJson(buildSeriesUrl(mangaId)),
      requestJson(buildChaptersUrl(mangaId, 1, "asc")),
    ]);
    const manga = parseMangaDetails(detailResponse, mangaId);
    const chapters = parseChapterPage(chapterResponse, manga, true).chapters;
    const candidate =
      chapters.find((chapter) => chapter.additionalInfo?.locked === "true") ?? chapters.at(-1);
    assert.ok(candidate);

    const response = await requestJson(buildChapterUrl(mangaId, candidate.chapterId));
    const access = response as {
      images?: unknown[];
      requiresAuth?: unknown;
      requiresPurchase?: unknown;
    };
    assert.equal(typeof access.requiresPurchase, "boolean");
    if (access.requiresAuth === true) {
      assert.throws(
        () => parseChapterDetails(response, candidate),
        new RegExp(AUTH_REQUIRED_ERROR),
      );
      return;
    }
    if (
      access.requiresPurchase ||
      (access.requiresAuth !== undefined && typeof access.requiresAuth !== "boolean")
    ) {
      assert.throws(() => parseChapterDetails(response, candidate), new RegExp(LOCKED_ERROR));
      return;
    }

    const details = parseChapterDetails(response, candidate);
    assert.ok("pages" in details && details.pages.length > 0);
  });
});
