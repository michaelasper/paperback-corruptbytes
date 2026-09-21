import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { SourceManga } from "@paperback/types";

import {
  parseChapterDetails,
  parseChapters,
  parseComicsCards,
  parseMangaDetails,
  parseSearchResponse,
} from "./parsers.js";
import {
  TEMPLE_CHAPTER_HTML,
  TEMPLE_COMICS_HTML,
  TEMPLE_PREMIUM_CHAPTER_HTML,
  TEMPLE_SEARCH_JSON,
  TEMPLE_SERIES_HTML,
} from "./test-fixtures.js";

const sourceManga = (mangaId: string): SourceManga => ({
  mangaId,
  mangaInfo: {
    primaryTitle: "Walk In The Night [Complete Edition]",
    secondaryTitles: [],
    thumbnailUrl: "https://templetoons.com/icon.webp",
    synopsis: "Walk In The Night [Complete Edition]",
    contentRating: "Adult" as SourceManga["mangaInfo"]["contentRating"],
  },
});

describe("Temple search parsing", () => {
  it("maps search projects to stable series slugs with covers", () => {
    const page = parseSearchResponse(TEMPLE_SEARCH_JSON);
    assert.equal(page.items.length, 2);
    assert.equal(page.items[0]?.mangaId, "walk-in-the-night");
    assert.equal(page.items[0]?.title, "Walk In The Night [Complete Edition]");
    assert.match(page.items[0]?.imageUrl ?? "", /^https:\/\/media\.templetoons\.com\//);
    assert.equal(page.hasNextPage, false);
  });
});

describe("Temple series parsing", () => {
  it("reads title, badge, genres, and cover while preserving the slug", () => {
    const details = parseMangaDetails(TEMPLE_SERIES_HTML, "walk-in-the-night");
    assert.equal(details.mangaId, "walk-in-the-night");
    assert.equal(details.mangaInfo.primaryTitle, "Walk In The Night [Complete Edition]");
    assert.match(details.mangaInfo.thumbnailUrl ?? "", /covers\//);
    assert.ok((details.mangaInfo.tagGroups?.[0]?.tags.length ?? 0) >= 4);
  });

  it("reads relative chapter links and flags premium entries", () => {
    const chapters = parseChapters(TEMPLE_SERIES_HTML, sourceManga("walk-in-the-night"));
    assert.equal(chapters.length, 3);
    assert.equal(chapters[0]?.chapterId, "walk-in-the-night-chapter-66");
    assert.equal(chapters[0]?.additionalInfo?.locked, "true");
    assert.equal(chapters[2]?.chapterId, "walk-in-the-night-chapter-64");
    assert.equal(chapters[2]?.additionalInfo?.locked, undefined);
  });
});

describe("Temple reader parsing", () => {
  it("orders CDN page images from embedded flight markup", () => {
    const details = parseChapterDetails(TEMPLE_CHAPTER_HTML, {
      sourceManga: sourceManga("walk-in-the-night"),
      chapterId: "walk-in-the-night-chapter-65",
      langCode: "en",
      chapNum: 65,
      title: "Chapter 65",
    });
    if (!("pages" in details)) throw new Error("Temple reader did not return image pages.");
    assert.equal(details.pages.length, 7);
    assert.ok(
      details.pages.every((page: string) =>
        page.startsWith(
          "https://media.templetoons.com/file/terms54/uploads/series/walk-in-the-night/",
        ),
      ),
    );
  });

  it("rejects premium chapters with an account error instead of blank pages", () => {
    assert.throws(
      () =>
        parseChapterDetails(TEMPLE_PREMIUM_CHAPTER_HTML, {
          sourceManga: sourceManga("walk-in-the-night"),
          chapterId: "walk-in-the-night-chapter-66",
          langCode: "en",
          chapNum: 66,
          title: "Chapter 66",
        }),
      /premium and requires an account/,
    );
  });

  it("parses comics cards without trusting chapter links", () => {
    const page = parseComicsCards(TEMPLE_COMICS_HTML);
    assert.equal(page.items.length, 2);
    assert.equal(page.items[0]?.mangaId, "his-sole");
    assert.equal(page.items[1]?.mangaId, "evil-husband");
  });
});
