import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { ContentRating, type Request, type Response as PaperbackResponse } from "@paperback/types";
import { load } from "cheerio";

import { AtsumaruClient, CANONICAL_MANGA_ID_KEY } from "./client.js";
import type { AtsumaruHomeFeed } from "./models.js";
import {
  AVAILABLE_FILTERS_URL,
  buildAllChaptersUrl,
  buildChapterUrl,
  buildHomeUrl,
  buildMangaRatingUrl,
  buildMangaPageUrl,
  buildNovelChapterUrl,
  buildSearchUrl,
  fetchJson,
} from "./network.js";
import {
  contentRatingForAtsumaru,
  parseAvailableFilters,
  parseChapters,
  parseComicChapter,
  parseFeedResponse,
  parseMangaPage,
  parseMangaRatingResponse,
  parseNovelChapter,
  parseScanlators,
  parseSearchResponse,
} from "./parsers.js";

const live = process.env.ATSUMARU_LIVE_TESTS === "1";
const originalApplication = globalThis.Application;
const rawResponses = new Map<string, ArrayBuffer>();
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
        const body = await response.arrayBuffer();
        rawResponses.set(request.url, body);
        return [
          {
            url: response.url,
            status: response.status,
            headers: Object.fromEntries(response.headers.entries()),
            cookies: [],
          },
          body,
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

const rawResponse = (url: string): unknown => {
  const body = rawResponses.get(url);
  assert.ok(body, `No captured response for ${url}`);
  return JSON.parse(new TextDecoder().decode(body)) as unknown;
};

const record = (value: unknown): Record<string, unknown> => {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
};

const assertImage = async (url: string): Promise<void> => {
  assert.equal(new URL(url).origin, "https://cdn.atsu.moe");
  const response = await fetch(url, {
    headers: { "user-agent": userAgent },
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  assert.ok(response.body);
  const reader = response.body.getReader();
  let bytes = 0;
  try {
    assert.equal(response.status, 200, url);
    assert.match(response.headers.get("content-type") ?? "", /^image\//);
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      assert.ok(bytes <= 2 * 1024 * 1024, `${url} exceeds the 2 MiB image probe budget`);
    }
    assert.ok(bytes > 0, `${url} returned an empty image`);
  } finally {
    await reader.cancel();
  }
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
    const literalAnchors = new Map<string, ContentRating>([
      ["2VgNt", ContentRating.EVERYONE],
      ["cDiHx", ContentRating.MATURE],
      ["CM0wz", ContentRating.ADULT],
    ]);
    for (const mangaId of ["2VgNt", "cDiHx", "CM0wz", "DJqV8", "-aOD"]) {
      const ratingValue = await fetchJson(
        { url: buildMangaRatingUrl(mangaId), method: "GET" },
        { maxBytes: 1_024 },
      );
      const rating = parseMangaRatingResponse(ratingValue, mangaId);
      assert.ok(rating, `${mangaId} returned no index rating document`);
      assert.equal(rating.id, mangaId);
      const expected = contentRatingForAtsumaru(rating);
      const details = await new AtsumaruClient().getMangaDetails(mangaId);
      assert.equal(
        details.mangaInfo.contentRating,
        expected,
        `${mangaId} production detail rating diverged from Atsumaru's index`,
      );
      const anchor = literalAnchors.get(mangaId);
      if (anchor !== undefined) {
        assert.equal(
          details.mangaInfo.contentRating,
          anchor,
          `${mangaId} lost its stable literal rating anchor`,
        );
      }
    }
  });

  it("preserves library IDs, detail posters, and chapter variants", async () => {
    const matrix = [
      ["i77QI", "n-Tbee"],
      ["yjzI", "eDUePz"],
      ["fysb", "iIpspf"],
      ["k0UZ", "y1pk4q"],
      ["0kwh", "93olZ7"],
      ["7nZTg", "wZieNneB"],
      ["lwT7", "h4j-gl"],
      ["68Fv", "JOY5r"],
      ["oJQ4o", "zFL0iqq5"],
      ["WSj0S", "GsBiAm"],
      ["cDiHx", "pJExwKsZ"],
      ["N7JpR", "K0pE5ORo"],
      ["uqZM", "5X4jYt"],
    ] as const;

    const chapterRequests: string[] = [];
    const client = new AtsumaruClient({
      fetchText: async (request) => {
        chapterRequests.push(request.url);
        return JSON.stringify(await getCachedJson(request.url));
      },
    });

    for (const [mangaId, chapterId] of matrix) {
      const pageValue = await getCachedJson(buildMangaPageUrl(mangaId));
      const sourceManga = parseMangaPage(pageValue, mangaId);
      sourceManga.mangaInfo.additionalInfo = {
        ...sourceManga.mangaInfo.additionalInfo,
        [CANONICAL_MANGA_ID_KEY]: mangaId,
      };
      const requestStart = chapterRequests.length;
      const chapters = await client.getChapters(sourceManga);
      assert.ok(
        chapters.some((chapter) => chapter.chapterId === chapterId),
        `${mangaId}/${chapterId} no longer resolves`,
      );
      assert.ok(
        chapters.every((chapter) => typeof chapter.version === "string" && chapter.version.length),
        `${mangaId} returned a chapter without a bridge-safe scanlation version`,
      );
      assert.deepEqual(
        chapterRequests.slice(requestStart),
        [buildAllChaptersUrl(mangaId)],
        `${mangaId} chapter loading made an auxiliary request`,
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

  it("resolves a legacy library ID to the affected title's complete current chapter range", async () => {
    const currentMangaId = "68Fv";
    const current = parseMangaPage(
      await getCachedJson(buildMangaPageUrl(currentMangaId)),
      currentMangaId,
    );
    const legacy = { ...current, mangaId: "legacy-68Fv" };
    const client = new AtsumaruClient({
      fetchText: async (request) => JSON.stringify(await getCachedJson(request.url)),
    });

    const chapters = await client.getChapters(legacy, undefined, false);
    current.mangaInfo.additionalInfo = {
      ...current.mangaInfo.additionalInfo,
      [CANONICAL_MANGA_ID_KEY]: currentMangaId,
    };
    const canonical = await client.getChapters(current, undefined, false);
    assert.ok(canonical.length > 0);
    assert.deepEqual(
      chapters.map(({ chapterId }) => chapterId),
      canonical.map(({ chapterId }) => chapterId),
    );
    assert.ok(chapters.every(({ sourceManga }) => sourceManga.mangaId === "legacy-68Fv"));
    assert.ok(
      chapters.every(
        ({ additionalInfo }) => additionalInfo?.[CANONICAL_MANGA_ID_KEY] === currentMangaId,
      ),
    );
  });

  it("retains raw chapter IDs, order and reader content across four bounded series", async (context) => {
    const client = new AtsumaruClient();
    for (const mangaId of ["68Fv", "N7JpR", "oJQ4o", "-aOD"]) {
      const manga = await client.getMangaDetails(mangaId);
      const chapters = await client.getChapters(manga, undefined, true);
      const raw = record(rawResponse(buildAllChaptersUrl(mangaId))).chapters;
      assert.ok(Array.isArray(raw) && raw.length > 0 && raw.length <= 20_000);
      const rawChapters = raw.map((value: unknown) => {
        const item = record(value);
        assert.ok(typeof item.id === "string" && item.id.length > 0);
        assert.ok(typeof item.number === "number" && Number.isFinite(item.number));
        assert.ok(
          typeof item.index === "number" && Number.isSafeInteger(item.index) && item.index >= 0,
        );
        assert.ok(typeof item.createdAt === "number" && Number.isSafeInteger(item.createdAt));
        return {
          id: item.id,
          number: item.number,
          index: item.index,
          createdAt: item.createdAt,
        };
      });
      const rawById = new Map(rawChapters.map((item) => [item.id, item]));
      assert.equal(
        rawById.size,
        rawChapters.length,
        `${mangaId} has duplicate raw IDs requiring review`,
      );
      assert.deepEqual(
        new Set(chapters.map(({ chapterId }) => decodeURIComponent(chapterId))),
        new Set(rawById.keys()),
      );
      assert.equal(chapters.length, rawById.size);
      assert.deepEqual(
        chapters.map(({ sortingIndex }) => sortingIndex),
        chapters.map((_, index) => index),
      );
      for (const [index, chapter] of chapters.entries()) {
        const current = rawById.get(decodeURIComponent(chapter.chapterId));
        assert.ok(current);
        assert.equal(chapter.chapNum, current.number);
        if (index === 0) continue;
        const previousChapter = chapters[index - 1];
        assert.ok(previousChapter);
        const previous = rawById.get(decodeURIComponent(previousChapter.chapterId));
        assert.ok(previous);
        assert.ok(
          current.number > previous.number ||
            (current.number === previous.number &&
              (current.index > previous.index ||
                (current.index === previous.index && current.createdAt >= previous.createdAt))),
          `${mangaId} raw ordering changed`,
        );
      }
      const since = await client.getChapters(manga, new Date(), true);
      assert.deepEqual(
        since.map(({ chapterId }) => chapterId),
        chapters.map(({ chapterId }) => chapterId),
      );
      const collapsed = await client.getChapters(manga, undefined, false);
      assert.deepEqual(
        new Set(collapsed.map(({ chapNum }) => chapNum)),
        new Set(rawChapters.map(({ number }) => number)),
      );
      assert.equal(collapsed.length, new Set(rawChapters.map(({ number }) => number)).size);

      let pages = 0;
      let paragraphs = 0;
      let images = 0;
      for (const index of new Set([0, Math.floor(chapters.length / 2), chapters.length - 1])) {
        const chapter = chapters[index];
        assert.ok(chapter);
        const details = await client.getChapterDetails(chapter);
        assert.equal(details.id, chapter.chapterId);
        assert.equal(details.mangaId, mangaId);
        if ("pages" in details) {
          const reader = record(
            record(rawResponse(buildChapterUrl(mangaId, chapter.chapterId))).readChapter,
          );
          const rawPages = reader.pages;
          assert.ok(Array.isArray(rawPages) && rawPages.length > 0 && rawPages.length <= 10_000);
          const ordered = rawPages
            .map((value: unknown) => {
              const page = record(value);
              assert.ok(typeof page.number === "number" && Number.isFinite(page.number));
              assert.ok(typeof page.image === "string");
              assert.match(page.image, /^\/static\/pages\/(?:[A-Za-z0-9_-]+\/)+[A-Za-z0-9_.-]+$/);
              return { number: page.number, url: new URL(page.image, "https://cdn.atsu.moe").href };
            })
            .sort((left, right) => left.number - right.number);
          assert.deepEqual(details.pages, [...new Set(ordered.map(({ url }) => url))]);
          pages += ordered.length;
          for (const imageIndex of new Set([0, details.pages.length - 1])) {
            const image: string | undefined = details.pages[imageIndex];
            assert.ok(image);
            await assertImage(image);
            images += 1;
          }
        } else {
          assert.equal(details.type, "html");
          const reader = record(
            record(rawResponse(buildNovelChapterUrl(mangaId, chapter.chapterId))).readNovelChapter,
          );
          const rawParagraphs = reader.paragraphs;
          assert.ok(
            Array.isArray(rawParagraphs) &&
              rawParagraphs.length > 0 &&
              rawParagraphs.length <= 4_096,
          );
          const expected = rawParagraphs
            .map((value: unknown) => {
              assert.ok(typeof value === "string" && value.length <= 100_000);
              return value.trim().replace(/\r\n/g, "\n");
            })
            .filter(Boolean);
          assert.ok(expected.join("").length <= 1_000_000);
          const $ = load(details.html, { xml: true });
          $("br").replaceWith("\n");
          assert.deepEqual(
            $("p")
              .toArray()
              .map((element) => $(element).text()),
            expected,
          );
          assert.equal($("script").length, 0);
          paragraphs += expected.length;
        }
      }
      context.diagnostic(
        JSON.stringify({
          mangaId,
          rawChapters: rawChapters.length,
          retained: chapters.length,
          pages,
          paragraphs,
          images,
        }),
      );
    }
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

    await assertImage(details.pages[0]!);
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
