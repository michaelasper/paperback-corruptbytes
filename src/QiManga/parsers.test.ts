import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ContentRating, type SourceManga } from "@paperback/types";

import { seriesSlugToId } from "./network.js";
import {
  AUTH_REQUIRED_ERROR,
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
    assert.equal(cards[0]?.status, "ONGOING");
    assert.equal(cards[0]?.contentRating, ContentRating.ADULT);
    assert.equal(
      parseSeriesCards([{ ...HOME_RESPONSE.banners[0], status: " ongoing " }])[0]?.status,
      undefined,
    );
    assert.deepEqual(
      parseSeriesCards([{ ...HOME_RESPONSE.banners[0], redirectUrl: "x".repeat(2_049) }]),
      [],
    );
    assert.deepEqual(
      parseSeriesCards([{ ...HOME_RESPONSE.banners[0], redirectUrl: " ".repeat(2_049) }]),
      [],
    );
    assert.deepEqual(parseSeriesCards([{ ...HOME_RESPONSE.banners[0], redirectUrl: " " }]), []);
    assert.deepEqual(
      parseSeriesCards([{ ...HOME_RESPONSE.banners[0], title: "Unsafe\ud800title" }]),
      [],
    );
    assert.equal(
      parseSeriesCards([{ ...HOME_RESPONSE.banners[0], title: "Safe 😀 title" }])[0]?.title,
      "Safe 😀 title",
    );
    assert.deepEqual(
      parseSeriesCards([{ ...HOME_RESPONSE.banners[0], slug: " padded-series " }]),
      [],
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
      () => parseSeriesPage({ data: [], current: 1, totalPages: 1, totalItems: "0" }),
      /invalid paginated series/i,
    );
    assert.throws(
      () => parseSeriesPage({ data: [], current: 1, totalPages: 1 }),
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
    assert.throws(
      () => parseSeriesPage({ data: [], current: 1, totalPages: 10_001, totalItems: 0 }),
      /invalid paginated series/i,
    );
    assert.throws(
      () =>
        parseSeriesPage({
          data: Array.from({ length: 101 }, () => HOME_RESPONSE.banners[0]),
          current: 1,
          totalPages: 1,
          totalItems: 101,
        }),
      /invalid series list/i,
    );
    assert.throws(
      () => parseSeriesPage({ data: [], current: 1, totalPages: 1, totalItems: 1_000_001 }),
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
    assert.equal(manga.mangaInfo.status, "Ongoing");
    assert.equal(
      parseMangaDetails(
        { ...SERIES_DETAIL, status: " ongoing " },
        seriesSlugToId(SERIES_DETAIL.slug),
      ).mangaInfo.status,
      undefined,
    );
    assert.equal(manga.mangaInfo.contentRating, ContentRating.MATURE);
    assert.equal(manga.mangaInfo.rating, 0.9);
    assert.equal(manga.mangaInfo.author, "A. Writer");
    assert.equal(manga.mangaInfo.artist, "B. Artist");
    assert.doesNotMatch(manga.mangaInfo.synopsis, /script|steal/i);
    assert.match(manga.mangaInfo.synopsis, /returns & takes control/);
    assert.equal(
      parseMangaDetails(
        { ...SERIES_DETAIL, description: "unsafe\ud800description" },
        seriesSlugToId(SERIES_DETAIL.slug),
      ).mangaInfo.synopsis,
      "",
    );
    assert.deepEqual(
      parseMangaDetails(
        {
          ...SERIES_DETAIL,
          alternativeTitles: `The Supreme Demon Swordmaster\nLine Alias\n${"x".repeat(1_025)};Final Alias`,
        },
        seriesSlugToId(SERIES_DETAIL.slug),
      ).mangaInfo.secondaryTitles,
      ["Line Alias", "Final Alias"],
    );
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
    assert.throws(
      () =>
        parseMangaDetails(
          { ...SERIES_DETAIL, slug: ` ${SERIES_DETAIL.slug}` },
          seriesSlugToId(SERIES_DETAIL.slug),
        ),
      /invalid series detail/i,
    );
    for (const redirectUrl of [
      "https://example.com/title",
      " ",
      "x".repeat(2_049),
      " ".repeat(2_049),
    ]) {
      assert.throws(
        () => parseMangaDetails({ ...SERIES_DETAIL, redirectUrl }, "the-supreme-demon-swordmaster"),
        /redirects to another website/i,
      );
    }
    for (const chapterCount of [10_001, -1, 1.5, Number.NaN, "12"]) {
      assert.throws(
        () =>
          parseMangaDetails(
            { ...SERIES_DETAIL, stats: { ...SERIES_DETAIL.stats, chapterCount } },
            seriesSlugToId(SERIES_DETAIL.slug),
          ),
        /invalid series detail/i,
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

    const malformedAuthentication = parseChapterPage(
      {
        ...CHAPTER_PAGE_ONE,
        data: [{ ...paid, requiresPurchase: false, requiresAuth: "false" }],
        totalItems: 1,
        totalPages: 1,
      },
      comicManga,
      false,
    );
    assert.deepEqual(malformedAuthentication.chapters, []);
  });

  it("rejects malformed structural chapter data instead of silently truncating it", () => {
    for (const malformed of [
      { ...CHAPTER_PAGE_ONE.data[0], number: "1" },
      { ...CHAPTER_PAGE_ONE.data[0], slug: "unsafe-number", number: 2 ** 53 },
      { ...CHAPTER_PAGE_ONE.data[0], slug: " padded-chapter " },
      { ...CHAPTER_PAGE_ONE.data[0], number: 10_000_001 },
    ]) {
      assert.throws(
        () =>
          parseChapterPage(
            {
              ...CHAPTER_PAGE_ONE,
              data: [malformed],
              totalItems: 1,
              totalPages: 1,
            },
            comicManga,
            true,
          ),
        /invalid chapter entry/i,
      );
    }
    assert.throws(
      () =>
        parseChapterPage(
          { ...CHAPTER_PAGE_ONE, data: [], totalItems: "0", totalPages: 1 },
          comicManga,
          true,
        ),
      /invalid paginated chapter/i,
    );
    assert.throws(
      () => parseChapterPage({ data: [], current: 1, totalPages: 1 }, comicManga, true),
      /invalid paginated chapter/i,
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
    assert.throws(
      () => finalizeChapters([page.chapters[0]!, { ...page.chapters[0]!, chapNum: 99 }]),
      /conflicting rows for the same chapter/i,
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
    assert.match(details.html, /href="#note"/);
    assert.doesNotMatch(details.html, /script|onclick|javascript:|tracker\.example|evil\.example/i);
    for (const content of [
      "<p>unsafe\ud800content</p>",
      "<p>unsafe\uffffcontent</p>",
      "<p>unsafe\u{1fffe}content</p>",
    ]) {
      assert.throws(
        () =>
          parseChapterDetails(
            { ...NOVEL_CHAPTER_RESPONSE, content },
            chapterFor(novelManga, "chapter-32", 32),
          ),
        /no readable pages or novel text/i,
      );
    }
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
    assert.throws(
      () =>
        parseChapterDetails(
          { ...COMIC_CHAPTER_RESPONSE, requiresPurchase: false, requiresAuth: "false" },
          chapterFor(comicManga, "chapter-3", 3),
        ),
      new RegExp(LOCKED_ERROR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
    assert.throws(
      () =>
        parseChapterDetails(
          { ...COMIC_CHAPTER_RESPONSE, requiresPurchase: false, requiresAuth: true },
          chapterFor(comicManga, "chapter-3", 3),
        ),
      new RegExp(AUTH_REQUIRED_ERROR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
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
          { ...COMIC_CHAPTER_RESPONSE, slug: " chapter-3 " },
          chapterFor(comicManga, "chapter-3", 3),
        ),
      /different chapter/i,
    );
    assert.throws(
      () =>
        parseChapterDetails(
          { ...COMIC_CHAPTER_RESPONSE, number: 4 },
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
            number: 3,
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
    for (const images of [
      [
        {
          url: "https://media.qimanga.com/pages/huge-order.webp",
          order: 1_000_001,
        },
      ],
      [{ url: "https://media.qimanga.com/pages/missing-order.webp" }],
    ]) {
      assert.throws(
        () =>
          parseChapterDetails(
            {
              ...COMIC_CHAPTER_RESPONSE,
              images,
            },
            chapterFor(comicManga, "chapter-3", 3),
          ),
        /invalid chapter image entry/i,
      );
    }
    assert.throws(
      () =>
        parseChapterDetails(
          {
            ...COMIC_CHAPTER_RESPONSE,
            images: [
              COMIC_CHAPTER_RESPONSE.images[0],
              { url: "https://tracker.example/private.webp", order: 2 },
            ],
          },
          chapterFor(comicManga, "chapter-3", 3),
        ),
      /invalid chapter image entry/i,
    );
    assert.throws(
      () => parseChapterPage({ ...CHAPTER_PAGE_ONE, data: Array(101).fill({}) }, comicManga, true),
      /invalid chapter list/i,
    );
    assert.throws(
      () => finalizeChapters(Array(10_001).fill(CHAPTER_PAGE_ONE.data[0] as never)),
      /too many chapters/i,
    );
  });
});

describe("Qi Manga taxonomy parser", () => {
  it("sorts and deduplicates live genre slugs", () => {
    assert.deepEqual(
      parseGenres([...GENRES_RESPONSE, { slug: " padded-genre ", name: "Padded" }]),
      [
        { id: "action", title: "Action" },
        { id: "adventure-589", title: "Adventure" },
        { id: "ecchi", title: "Ecchi" },
      ],
    );
  });
});
