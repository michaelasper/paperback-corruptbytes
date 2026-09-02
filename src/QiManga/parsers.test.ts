import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ContentRating, type SourceManga } from "@paperback/types";

import { seriesSlugToId } from "./network.js";
import {
  FALLBACK_COVER_URL,
  LOCKED_ERROR,
  finalizeChapters,
  parseChapterDetails,
  parseChapterPage,
  parseDate,
  parseGenres,
  parseHome,
  parseMangaDetails,
  parseSeriesCards,
  parseSeriesPage,
} from "./parsers.js";
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
  SERIES_DETAIL,
} from "./test-fixtures.js";

const comicManga = parseMangaDetails(
  SERIES_DETAIL,
  seriesSlugToId("the-supreme-demon-swordmaster"),
);
const novelManga = parseMangaDetails(NOVEL_DETAIL, seriesSlugToId("i'm-a-soldier-in-america"));

const chapterFor = (sourceManga: SourceManga, chapterId: string, chapNum: number) => ({
  chapterId: seriesSlugToId(chapterId),
  sourceManga,
  langCode: "en",
  chapNum,
});

describe("Qi Manga series parsers", () => {
  it("parses cards, scales ratings, deduplicates IDs, and refuses external redirects", () => {
    const cards = parseSeriesCards([
      HOME_RESPONSE.banners[0],
      HOME_RESPONSE.banners[0],
      HOME_RESPONSE.banners[1],
      { slug: "bad", title: "", cover: "javascript:alert(1)" },
    ]);

    assert.equal(cards.length, 1);
    assert.equal(cards[0]?.mangaId, "the-supreme-demon-swordmaster");
    assert.equal(cards[0]?.rating, 0.82);
    assert.equal(cards[0]?.type, "MANHWA");
    assert.equal(cards[0]?.contentRating, ContentRating.ADULT);
    assert.deepEqual(
      parseSeriesCards([{ ...HOME_RESPONSE.banners[0], redirectUrl: "x".repeat(2_049) }]),
      [],
    );
  });

  it("never normalizes opaque series or genre identifiers", () => {
    assert.deepEqual(
      parseSeriesCards([{ ...HOME_RESPONSE.banners[0], slug: " the-supreme-demon-swordmaster " }]),
      [],
    );
    assert.throws(
      () =>
        parseMangaDetails(
          { ...SERIES_DETAIL, slug: " the-supreme-demon-swordmaster " },
          seriesSlugToId("the-supreme-demon-swordmaster"),
        ),
      /invalid series detail/i,
    );
    assert.deepEqual(
      parseGenres([
        { slug: " action ", name: "Action" },
        { slug: "action", name: "Action" },
      ]),
      [{ id: "action", title: "Action" }],
    );
  });

  it("accepts observed CDNs and replaces all other API-provided cover hosts", () => {
    const [legacyCard] = parseSeriesCards([
      {
        ...HOME_RESPONSE.banners[0],
        cover: "https://media.quantumscans.org/cover.webp",
      },
    ]);
    const [foreignCard] = parseSeriesCards([
      { ...HOME_RESPONSE.banners[0], cover: "https://tracker.example/cover.webp" },
    ]);
    const details = parseMangaDetails(
      { ...SERIES_DETAIL, cover: "https://qimanga.com/untrusted-relative-target.webp" },
      seriesSlugToId(SERIES_DETAIL.slug),
    );
    assert.equal(legacyCard?.imageUrl, "https://media.quantumscans.org/cover.webp");
    assert.equal(foreignCard?.imageUrl, FALLBACK_COVER_URL);
    assert.equal(details.mangaInfo.thumbnailUrl, FALLBACK_COVER_URL);
  });

  it("parses every home rail independently", () => {
    const home = parseHome(HOME_RESPONSE);
    assert.deepEqual(
      Object.fromEntries(Object.entries(home).map(([key, items]) => [key, items.length])),
      { banners: 1, popular: 1, newSeries: 1, pinned: 1, editorsPick: 1 },
    );
  });

  it("validates pagination metadata and preserves the API next-page boundary", () => {
    const page = parseSeriesPage(LATEST_RESPONSE);
    assert.equal(page.page, 1);
    assert.equal(page.pageCount, 2);
    assert.equal(page.totalCount, 42);
    assert.equal(page.items.length, 2);
    assert.throws(
      () => parseSeriesPage({ data: [], current: "wat", totalPages: 1 }),
      /invalid paginated series/i,
    );
    assert.throws(
      () => parseSeriesPage({ data: [], current: "1", totalPages: 1 }),
      /invalid paginated series/i,
    );
    assert.throws(
      () => parseSeriesPage({ data: [], current: 2, totalPages: 1, totalItems: 0 }),
      /invalid paginated series/i,
    );
    assert.throws(
      () => parseSeriesPage({ data: [HOME_RESPONSE.banners[0]], current: 1, totalPages: 0 }),
      /invalid paginated series/i,
    );
  });

  it("parses only canonical UTC timestamps without calendar rollover", () => {
    assert.equal(parseDate("2026-01-02T03:04:05Z")?.toISOString(), "2026-01-02T03:04:05.000Z");
    assert.equal(parseDate("2026-01-02T03:04:05.12z")?.toISOString(), "2026-01-02T03:04:05.120Z");
    assert.equal(parseDate("2026-02-30T03:04:05.000Z"), undefined);
    assert.equal(parseDate("01/02/2026 03:04:05"), undefined);
  });

  it("parses complete details without retaining active markup", () => {
    const manga = comicManga;
    assert.equal(manga.mangaInfo.primaryTitle, "The Supreme Demon Swordmaster");
    assert.deepEqual(manga.mangaInfo.secondaryTitles, [
      "The Strongest Demon Swordsman",
      "마검지존",
    ]);
    assert.equal(manga.mangaInfo.contentType, "comic");
    assert.equal(manga.mangaInfo.contentRating, ContentRating.MATURE);
    assert.equal(manga.mangaInfo.rating, 0.9);
    assert.equal(manga.mangaInfo.author, "A. Writer");
    assert.equal(manga.mangaInfo.artist, "B. Artist");
    assert.doesNotMatch(manga.mangaInfo.synopsis, /script|steal/i);
    assert.match(manga.mangaInfo.synopsis, /returns & takes control/);
    assert.deepEqual(
      manga.mangaInfo.tagGroups?.[0]?.tags.map((genre) => genre.id),
      ["action", "ecchi"],
    );
    assert.equal(
      manga.mangaInfo.shareUrl,
      "https://qimanga.com/series/the-supreme-demon-swordmaster",
    );
  });

  it("round-trips apostrophes in stable novel IDs", () => {
    assert.equal(novelManga.mangaId, "i%27m-a-soldier-in-america");
    assert.equal(novelManga.mangaInfo.contentType, "novel");
    assert.equal(
      novelManga.mangaInfo.shareUrl,
      "https://qimanga.com/series/i%27m-a-soldier-in-america",
    );
  });

  it("rejects detail responses for a different source ID or an external redirect", () => {
    assert.throws(() => parseMangaDetails(SERIES_DETAIL, "different-series"), /different series/i);
    for (const redirectUrl of ["https://example.com/title", "x".repeat(2_049)]) {
      assert.throws(
        () => parseMangaDetails({ ...SERIES_DETAIL, redirectUrl }, "the-supreme-demon-swordmaster"),
        /redirects to another website/i,
      );
    }
  });
});

describe("Qi Manga chapter parsers", () => {
  it("keeps stable fractional IDs and exposes paid state without unlocking it", () => {
    const first = parseChapterPage(CHAPTER_PAGE_ONE, comicManga, true);
    const second = parseChapterPage(CHAPTER_PAGE_TWO, comicManga, true);
    const chapters = finalizeChapters([...second.chapters, ...first.chapters]);

    assert.deepEqual(
      chapters.map((chapter) => chapter.chapNum),
      [1, 2.5, 3, 4],
    );
    assert.deepEqual(
      chapters.map((chapter) => chapter.sortingIndex),
      [0, 1, 2, 3],
    );
    assert.equal(chapters[1]?.chapterId, "chapter-2-5");
    assert.equal(chapters[1]?.additionalInfo?.locked, "true");
    assert.equal(chapters[1]?.additionalInfo?.price, "25");
    assert.equal(chapters[1]?.title, "🔒 25 coins • A side story");
    assert.equal(chapters[2]?.publishDate, undefined);
  });

  it("omits unavailable chapters when the user disables locked rows", () => {
    const page = parseChapterPage(CHAPTER_PAGE_ONE, comicManga, false);
    assert.deepEqual(
      page.chapters.map((chapter) => chapter.chapNum),
      [1],
    );
  });

  it("keeps explicitly granted paid chapters visible as purchased", () => {
    const paid = CHAPTER_PAGE_ONE.data[1]!;
    const page = parseChapterPage(
      {
        ...CHAPTER_PAGE_ONE,
        data: [{ ...paid, isFree: false, requiresPurchase: false }],
        totalItems: 1,
        totalPages: 1,
      },
      comicManga,
      false,
    );
    assert.equal(page.chapters.length, 1);
    assert.equal(page.chapters[0]?.additionalInfo?.locked, "false");
    assert.equal(page.chapters[0]?.title, "A side story");
  });

  it("does not coerce numeric strings from untrusted chapter payloads", () => {
    const page = parseChapterPage(
      {
        ...CHAPTER_PAGE_ONE,
        data: [{ ...CHAPTER_PAGE_ONE.data[0], number: "1" }],
        totalItems: 1,
        totalPages: 1,
      },
      comicManga,
      true,
    );
    assert.deepEqual(page.chapters, []);
  });

  it("never normalizes opaque chapter or owning-series identifiers", () => {
    const page = parseChapterPage(
      {
        ...CHAPTER_PAGE_ONE,
        data: [{ ...CHAPTER_PAGE_ONE.data[0], slug: " chapter-1 " }],
        totalItems: 1,
        totalPages: 1,
      },
      comicManga,
      true,
    );
    assert.deepEqual(page.chapters, []);
    assert.throws(
      () =>
        parseChapterDetails(
          { ...COMIC_CHAPTER_RESPONSE, slug: " chapter-3 " },
          chapterFor(comicManga, "chapter-3", 3),
        ),
      /different chapter/i,
    );
    assert.throws(
      () =>
        parseChapterDetails(
          {
            ...COMIC_CHAPTER_RESPONSE,
            series: { slug: " the-supreme-demon-swordmaster " },
          },
          chapterFor(comicManga, "chapter-3", 3),
        ),
      /different series/i,
    );
  });

  it("sorts, deduplicates, and assigns deterministic indices", () => {
    const page = parseChapterPage(CHAPTER_PAGE_ONE, comicManga, true);
    const chapters = finalizeChapters([
      page.chapters[1]!,
      page.chapters[0]!,
      { ...page.chapters[0]! },
    ]);
    assert.deepEqual(
      chapters.map((chapter) => chapter.chapNum),
      [1, 2.5],
    );
    assert.deepEqual(
      chapters.map((chapter) => chapter.sortingIndex),
      [0, 1],
    );
  });

  it("orders, validates, and deduplicates comic pages", () => {
    const details = parseChapterDetails(
      COMIC_CHAPTER_RESPONSE,
      chapterFor(comicManga, "chapter-3", 3),
    );
    assert.ok("pages" in details);
    if (!("pages" in details)) assert.fail("Expected image chapter details.");
    assert.deepEqual(details.pages, [
      "https://media.qimanga.com/pages/01.webp",
      "https://media.qimanga.com/pages/02.webp",
    ]);
  });

  it("sanitizes novel HTML into a self-contained reader document", () => {
    const details = parseChapterDetails(
      NOVEL_CHAPTER_RESPONSE,
      chapterFor(novelManga, "chapter-32", 32),
    );
    assert.ok("html" in details);
    if (!("html" in details)) assert.fail("Expected novel chapter details.");
    assert.match(details.html, /^<html xmlns=/);
    assert.match(details.html, /First &amp; safe/);
    assert.match(details.html, /Second/);
    assert.match(details.html, /https:\/\/media\.qiscans\.org\/illustration\.webp/);
    assert.doesNotMatch(details.html, /script|onclick|javascript:|tracker\.example/i);
  });

  it("accepts explicit account grants for paid chapters but fails closed on ambiguous access", () => {
    const purchased = parseChapterDetails(
      { ...COMIC_CHAPTER_RESPONSE, isFree: false, requiresPurchase: false },
      chapterFor(comicManga, "chapter-3", 3),
    );
    assert.ok("pages" in purchased);
    assert.throws(
      () =>
        parseChapterDetails(
          { ...COMIC_CHAPTER_RESPONSE, requiresPurchase: undefined },
          chapterFor(comicManga, "chapter-3", 3),
        ),
      new RegExp(LOCKED_ERROR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
  });

  it("reports locks and response-ID mismatches explicitly", () => {
    assert.throws(
      () => parseChapterDetails(LOCKED_CHAPTER_RESPONSE, chapterFor(comicManga, "chapter-52", 52)),
      new RegExp(LOCKED_ERROR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
    assert.throws(
      () =>
        parseChapterDetails(
          { ...COMIC_CHAPTER_RESPONSE, slug: "chapter-999" },
          chapterFor(comicManga, "chapter-3", 3),
        ),
      /different chapter/i,
    );
    assert.throws(
      () =>
        parseChapterDetails(
          { ...COMIC_CHAPTER_RESPONSE, series: { slug: "different-series" } },
          chapterFor(comicManga, "chapter-3", 3),
        ),
      /different series/i,
    );
  });

  it("rejects empty content and bounded-array violations", () => {
    assert.throws(
      () =>
        parseChapterDetails(
          {
            slug: "chapter-3",
            series: { slug: "the-supreme-demon-swordmaster" },
            isFree: true,
            requiresPurchase: false,
            images: [],
          },
          chapterFor(comicManga, "chapter-3", 3),
        ),
      /no readable pages/i,
    );
    assert.throws(
      () =>
        parseChapterDetails(
          {
            ...NOVEL_CHAPTER_RESPONSE,
            content: "<script>no readable content</script>",
          },
          chapterFor(novelManga, "chapter-32", 32),
        ),
      /no readable pages/i,
    );
    assert.throws(
      () => parseChapterPage({ ...CHAPTER_PAGE_ONE, data: Array(101).fill({}) }, comicManga, true),
      /invalid chapter list/i,
    );
  });
});

describe("Qi Manga taxonomy parser", () => {
  it("sorts and deduplicates live genre slugs", () => {
    assert.deepEqual(parseGenres(GENRES_RESPONSE), [
      { id: "action", title: "Action" },
      { id: "adventure-589", title: "Adventure" },
      { id: "ecchi", title: "Ecchi" },
    ]);
  });
});
