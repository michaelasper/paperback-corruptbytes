import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { ContentRating, type Request, type Response as PaperbackResponse } from "@paperback/types";

import type { AtsumaruHomeFeed } from "./models.js";
import {
  AVAILABLE_FILTERS_URL,
  buildAllChaptersUrl,
  buildChapterUrl,
  buildHomeUrl,
  buildMangaDocumentUrl,
  buildMangaPageUrl,
  buildNovelChapterUrl,
  buildSearchUrl,
  fetchJson,
} from "./network.js";
import {
  parseAvailableFilters,
  parseChapters,
  parseComicChapter,
  parseFeedResponse,
  parseMangaPage,
  parseMangaRatingDocument,
  parseNovelChapter,
  parseScanlators,
  parseSearchResponse,
} from "./parsers.js";

const live = process.env.ATSUMARU_LIVE_TESTS === "1";
const originalApplication = globalThis.Application;
const userAgent = "Mozilla/5.0 PaperbackExtensionLiveContract/1.0";

if (live) {
  Object.assign(globalThis, {
    Application: {
      arrayBufferToUTF8String: (buffer: ArrayBuffer) => new TextDecoder().decode(buffer),
      scheduleRequest: async (request: Request): Promise<[PaperbackResponse, ArrayBuffer]> => {
        const response = await fetch(request.url, {
          method: request.method,
          headers: { ...request.headers, "user-agent": userAgent },
          body: typeof request.body === "string" ? request.body : undefined,
          redirect: "follow",
          signal: AbortSignal.timeout(30_000),
        });
        return [
          {
            url: response.url,
            status: response.status,
            headers: Object.fromEntries(response.headers.entries()),
            cookies: [],
          },
          await response.arrayBuffer(),
        ];
      },
    },
  });
}

after(() => {
  if (live) Object.assign(globalThis, { Application: originalApplication });
});

const getJson = (url: string): Promise<unknown> => fetchJson({ url, method: "GET" });

const jsonCache = new Map<string, Promise<unknown>>();
const getCachedJson = (url: string): Promise<unknown> => {
  const cached = jsonCache.get(url);
  if (cached) return cached;
  const pending = getJson(url).catch((error: unknown) => {
    jsonCache.delete(url);
    throw error;
  });
  jsonCache.set(url, pending);
  return pending;
};

const HOME_FEEDS: AtsumaruHomeFeed[] = [
  "hotUpdates",
  "recentlyUpdated",
  "popular",
  "rising",
  "hotArrivals",
  "mostBookmarked",
  "genreSpotlight",
  "mostTalkedAbout",
  "recentlyAdded",
  "bingeWorthy",
  "mostPolarizing",
  "hiddenGems",
  "topRated",
];

const homeOptions = (feed: AtsumaruHomeFeed, adult = false) => ({
  offset: 0,
  limit: 3,
  ...(adult && { adult: true }),
  ...(feed === "genreSpotlight" && { genre: "Action" }),
  ...(["popular", "mostBookmarked", "mostTalkedAbout"].includes(feed) && {
    timeframe: feed === "popular" ? ("daily" as const) : ("weekly" as const),
  }),
});

describe("Atsumaru live anonymous contract", { skip: !live }, () => {
  it("serves a non-empty taxonomy and Typesense search contract", async () => {
    const filters = parseAvailableFilters(await getCachedJson(AVAILABLE_FILTERS_URL));
    assert.ok(filters.genres.length > 0);
    assert.ok(filters.types.length > 0);
    assert.ok(filters.statuses.length > 0);
    assert.ok(filters.tags.length > 0);

    const page = parseSearchResponse(
      await getCachedJson(buildSearchUrl({ title: "Pick Me Up" }, undefined, 1)),
    );
    assert.ok(page.items.some((item) => item.mangaId === "oJQ4o"));
  });

  it("parses every anonymous home rail, including an explicit adult catalog", async () => {
    const assertFeed = (value: unknown, label: string) => {
      const record = value as { items?: unknown[] };
      assert.ok(Array.isArray(record.items), `${label} did not return an items array`);
      assert.ok(record.items.length > 0, `${label} returned no public items`);
      const page = parseFeedResponse(value);
      assert.equal(
        page.items.length,
        record.items.length,
        `${label} returned a card the parser could not map`,
      );
      for (const item of page.items) {
        assert.ok(item.mangaId.length > 0, `${label} returned an empty manga ID`);
        assert.ok(item.title.length > 0, `${label} returned an empty title`);
        assert.match(
          item.imageUrl,
          /^https:\/\/cdn\.atsu\.moe\/static\/posters\//,
          `${label} returned an unsafe poster URL`,
        );
      }
      for (const [index, raw] of record.items.entries()) {
        const card = raw as Record<string, unknown>;
        const hasExplicitRating = ["mbContentRating", "contentRating", "classification"].some(
          (key) => typeof card[key] === "string" && card[key] !== "",
        );
        if (card.isAdult !== true && !hasExplicitRating) {
          assert.equal(
            page.items[index]?.contentRating,
            ContentRating.MATURE,
            `${label} understated an unrated card as safe`,
          );
        }
      }
      return page;
    };

    for (const feed of HOME_FEEDS) {
      assertFeed(await getCachedJson(buildHomeUrl(feed, homeOptions(feed))), feed);
    }

    const adult = assertFeed(
      await getCachedJson(buildHomeUrl("hotUpdates", homeOptions("hotUpdates", true))),
      "adult hotUpdates",
    );
    assert.ok(adult.items.every((item) => item.isAdult === true));
    assert.ok(adult.items.every((item) => item.contentRating === ContentRating.ADULT));
  });

  it("keeps detail ratings aligned with Atsumaru's authoritative index", async () => {
    for (const [mangaId, expected] of [
      ["2VgNt", ContentRating.EVERYONE],
      ["cDiHx", ContentRating.MATURE],
      ["CM0wz", ContentRating.ADULT],
      ["DJqV8", ContentRating.ADULT],
      ["-aOD", ContentRating.MATURE],
    ] as const) {
      const [pageValue, ratingValue] = await Promise.all([
        getCachedJson(buildMangaPageUrl(mangaId)),
        getCachedJson(buildMangaDocumentUrl(mangaId)),
      ]);
      const rating = parseMangaRatingDocument(ratingValue, mangaId);
      assert.ok(rating, `${mangaId} returned a mismatched rating document`);
      assert.equal(
        parseMangaPage(pageValue, mangaId, rating).mangaInfo.contentRating,
        expected,
        `${mangaId} detail rating diverged from Atsumaru's index`,
      );
    }
  });

  it("preserves library IDs, detail posters, and chapter variants", async () => {
    const matrix = [
      ["yjzI", "eDUePz"],
      ["fysb", "iIpspf"],
      ["7nZTg", "wZieNneB"],
      ["lwT7", "h4j-gl"],
      ["68Fv", "JOY5r"],
      ["oJQ4o", "zFL0iqq5"],
      ["WSj0S", "GsBiAm"],
      ["cDiHx", "pJExwKsZ"],
      ["N7JpR", "K0pE5ORo"],
      ["uqZM", "5X4jYt"],
    ] as const;

    for (const [mangaId, chapterId] of matrix) {
      const [pageValue, chapterValue] = await Promise.all([
        getCachedJson(buildMangaPageUrl(mangaId)),
        getCachedJson(buildAllChaptersUrl(mangaId)),
      ]);
      const sourceManga = parseMangaPage(pageValue, mangaId);
      const chapters = parseChapters(chapterValue, sourceManga, parseScanlators(pageValue));
      assert.ok(
        chapters.some((chapter) => chapter.chapterId === chapterId),
        `${mangaId}/${chapterId} no longer resolves`,
      );
    }

    for (const [mangaId, contentType] of [
      ["oJQ4o", "comic"],
      ["N7JpR", "comic"],
      ["-aOD", "novel"],
      ["slh2", "novel"],
    ] as const) {
      const manga = parseMangaPage(await getCachedJson(buildMangaPageUrl(mangaId)), mangaId);
      assert.equal(manga.mangaInfo.contentType, contentType);
      assert.match(
        manga.mangaInfo.thumbnailUrl,
        /^https:\/\/cdn\.atsu\.moe\/static\/posters\/[^/]+-medium\.(?:avif|webp|jpe?g|png)$/,
        `${mangaId} did not return a supported medium poster`,
      );
      const shareUrl = manga.mangaInfo.shareUrl;
      assert.ok(shareUrl, `${mangaId} did not return a share URL`);
      assert.match(
        shareUrl,
        new RegExp(`/${contentType === "novel" ? "novel" : "manga"}/${mangaId}$`),
      );
    }

    const variantPage = await getCachedJson(buildMangaPageUrl("N7JpR"));
    const variantManga = parseMangaPage(variantPage, "N7JpR");
    const variantChapters = parseChapters(
      await getCachedJson(buildAllChaptersUrl("N7JpR")),
      variantManga,
      parseScanlators(variantPage),
    );
    const zeroChapters = variantChapters.filter((chapter) => chapter.chapNum === 0);
    const fractionalChapters = variantChapters.filter(
      (chapter) => !Number.isInteger(chapter.chapNum),
    );
    assert.ok(zeroChapters.length > 0, "N7JpR lost its zero-numbered chapters");
    assert.ok(fractionalChapters.length > 0, "N7JpR lost its fractional chapters");
    assert.ok(
      new Set(zeroChapters.map((chapter) => chapter.additionalInfo?.scanlationId)).size >= 2,
      "N7JpR lost duplicate scanlation variants",
    );
    assert.ok(
      new Set(fractionalChapters.map((chapter) => chapter.title ?? "")).size >= 2,
      "N7JpR lost chapter title variants",
    );
  });

  it("reads a page-zero nested comic chapter and its direct CDN image", async () => {
    const mangaId = "oJQ4o";
    const chapterId = "zxOy4";
    const pageValue = await getCachedJson(buildMangaPageUrl(mangaId));
    const sourceManga = parseMangaPage(pageValue, mangaId);
    const chapter = parseChapters(
      await getCachedJson(buildAllChaptersUrl(mangaId)),
      sourceManga,
      parseScanlators(pageValue),
    ).find((candidate) => candidate.chapterId === chapterId);
    assert.ok(chapter);
    const details = parseComicChapter(
      await getCachedJson(buildChapterUrl(mangaId, chapterId)),
      chapter,
    );
    assert.ok("pages" in details && details.pages.length > 0);
    if (!("pages" in details)) assert.fail("Expected comic pages");
    assert.match(
      details.pages[0]!,
      /^https:\/\/cdn\.atsu\.moe\/static\/pages\/[^/]+\/[^/]+\//,
      "page zero did not retain its nested CDN path",
    );

    const response = await fetch(details.pages[0]!, {
      headers: { "user-agent": userAgent },
      signal: AbortSignal.timeout(30_000),
    });
    assert.equal(response.ok, true, `${response.status} from ${response.url}`);
    assert.match(response.headers.get("content-type") ?? "", /^image\//);
  });

  it("reads the public novel fixtures as escaped XHTML", async () => {
    for (const [mangaId, chapterId] of [
      ["39yf", "RVKLtl"],
      ["-aOD", "G4NNQx"],
      ["slh2", "woOJWu"],
    ] as const) {
      const sourceManga = parseMangaPage(await getCachedJson(buildMangaPageUrl(mangaId)), mangaId);
      const chapter = {
        chapterId,
        sourceManga,
        langCode: "en",
        chapNum: 1,
      };
      const details = parseNovelChapter(
        await getCachedJson(buildNovelChapterUrl(mangaId, chapterId)),
        chapter,
      );
      assert.equal(details.type, "html", `${mangaId}/${chapterId} was not rendered as XHTML`);
      if (details.type === "html") {
        assert.match(details.html, /^<html xmlns=/);
        assert.match(details.html, /<p>/);
        assert.doesNotMatch(details.html, /<script>/i);
      }
    }
  });
});
