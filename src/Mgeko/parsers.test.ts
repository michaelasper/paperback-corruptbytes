import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ContentRating, type Chapter, type SourceManga } from "@paperback/types";

import {
  parseBrowseCards,
  parseBrowseResponse,
  parseChapterDetails,
  parseChapters,
  parseDate,
  parseFilterOptions,
  parseMangaDetails,
} from "./parsers.js";
import {
  BROWSE_FILTER_HTML,
  BROWSE_RESULTS_HTML,
  CHAPTERS_HTML,
  READER_HTML,
  SERIES_HTML,
} from "./test-fixtures.js";

const sourceManga: SourceManga = {
  mangaId: "dark-%7E-mage",
  mangaInfo: {
    primaryTitle: "Dark ~ Mage",
    secondaryTitles: [],
    thumbnailUrl: "https://imgsrv5.com/dark.webp",
    synopsis: "",
    contentRating: ContentRating.MATURE,
  },
};

describe("Mgeko listing parsers", () => {
  it("validates browse envelopes and parses full titles, stats, safe IDs, and deduplication", () => {
    const envelope = parseBrowseResponse({
      results_html: BROWSE_RESULTS_HTML,
      page: 1,
      num_pages: 3,
      total_results: 50,
    });
    const items = parseBrowseCards(envelope.resultsHtml, { safeMode: true });

    assert.deepEqual(envelope, {
      resultsHtml: BROWSE_RESULTS_HTML,
      page: 1,
      pageCount: 3,
      totalCount: 50,
    });
    assert.equal(items.length, 2);
    assert.deepEqual(items[0], {
      mangaId: "dark-%7E-mage",
      title: "Dark ~ Mage",
      imageUrl: "https://imgsrv5.com/cover%20one.webp",
      rating: 0.9,
      views: 12345,
      badge: "Trending",
      contentRating: ContentRating.MATURE,
    });
    assert.equal(items[1]?.imageUrl, "https://www.mgeko.cc/favicon.ico");
    assert.equal(
      parseBrowseCards(BROWSE_RESULTS_HTML, { safeMode: false })[0]?.contentRating,
      ContentRating.ADULT,
    );
    assert.throws(() => parseBrowseResponse({ results_html: 12 }), /invalid browse response/i);
  });

  it("extracts exact live filter values in stable order", () => {
    assert.deepEqual(parseFilterOptions(BROWSE_FILTER_HTML), {
      genres: [
        { id: "Action", title: "Action" },
        { id: "Martial arts", title: "Martial Arts" },
        { id: "Mature", title: "Mature" },
      ],
      statuses: [
        { id: "ongoing", title: "Ongoing" },
        { id: "completed", title: "Completed" },
        { id: "hiatus", title: "Hiatus" },
      ],
      types: [
        { id: "manga", title: "Manga" },
        { id: "manhwa", title: "Manhwa" },
        { id: "manhua", title: "Manhua" },
        { id: "webtoon", title: "Webtoon" },
      ],
    });
  });
});

describe("Mgeko title and reader parsers", () => {
  it("parses complete details and derives conservative content ratings", () => {
    const result = parseMangaDetails(SERIES_HTML, "dark-%7E-mage");

    assert.equal(result.mangaId, "dark-%7E-mage");
    assert.equal(result.mangaInfo.primaryTitle, "Dark ~ Mage");
    assert.deepEqual(result.mangaInfo.secondaryTitles, ["暗黒の魔導士"]);
    assert.equal(result.mangaInfo.thumbnailUrl, "https://imgsrv5.com/dark.webp");
    assert.equal(result.mangaInfo.author, "A. Writer");
    assert.equal(result.mangaInfo.status, "Ongoing");
    assert.equal(result.mangaInfo.rating, 0.9);
    assert.equal(result.mangaInfo.contentRating, ContentRating.MATURE);
    assert.equal(result.mangaInfo.synopsis, "A careful synopsis & more.");
    assert.deepEqual(result.mangaInfo.additionalInfo, {
      Chapters: "21-1-eng-li",
      Views: "1.2 M",
      Bookmarked: "240",
    });
  });

  it("parses Django timestamps deterministically and never fabricates invalid dates", () => {
    assert.equal(parseDate("Aug. 6, 2026, 2:21 p.m.")?.toISOString(), "2026-08-06T14:21:00.000Z");
    assert.equal(parseDate("July 30, 2026, 2:04 p.m.")?.toISOString(), "2026-07-30T14:04:00.000Z");
    assert.equal(parseDate("not a date"), undefined);
  });

  it("preserves archived chapter slugs and converts fractional chapter suffixes", () => {
    const chapters = parseChapters(CHAPTERS_HTML, sourceManga);

    assert.deepEqual(
      chapters.map((chapter) => ({
        id: chapter.chapterId,
        number: chapter.chapNum,
        title: chapter.title,
        index: chapter.sortingIndex,
      })),
      [
        { id: "dark-%7E-mage-prologue-eng-li", number: 0, title: "Prologue", index: 0 },
        { id: "dark-%7E-mage-chapter-2-eng-li", number: 2, title: undefined, index: 1 },
        { id: "dark-%7E-mage-chapter-21-1-eng-li", number: 21.1, title: undefined, index: 2 },
      ],
    );
    assert.equal(chapters[0]?.publishDate, undefined);
    assert.equal(chapters[2]?.publishDate?.toISOString(), "2026-08-06T14:21:00.000Z");
  });

  it("keeps source page order while removing credits, duplicates, and unsafe URLs", () => {
    const chapter: Chapter = {
      chapterId: "dark-%7E-mage-chapter-21-1-eng-li",
      sourceManga,
      langCode: "en",
      chapNum: 21.1,
    };

    assert.deepEqual(parseChapterDetails(READER_HTML, chapter), {
      id: chapter.chapterId,
      mangaId: sourceManga.mangaId,
      pages: ["https://imgsrv5.com/pages/01.jpg", "https://imgsrv5.com/pages/02.jpg"],
    });
    assert.throws(() => parseChapterDetails("<html></html>", chapter), /no readable pages/i);
  });
});
