import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { SourceManga } from "@paperback/types";

import {
  parseCatalogCards,
  parseChapterDetails,
  parseChapters,
  parseFilterOptions,
  parseMangaDetails,
  parseSearchCards,
} from "./parsers.js";
import {
  ROKARI_CATALOG_HTML,
  ROKARI_CHAPTER_HTML,
  ROKARI_EMPTY_CHAPTER_HTML,
  ROKARI_SERIES_HTML,
} from "./test-fixtures.js";

const sourceManga = (mangaId: string): SourceManga => ({
  mangaId,
  mangaInfo: {
    primaryTitle: "Bunker Days",
    secondaryTitles: [],
    thumbnailUrl: "https://rokaricomics.com/cover.webp",
    synopsis: "Bunker Days",
    contentRating: "Mature" as SourceManga["mangaInfo"]["contentRating"],
  },
});

describe("Rokari catalog parsing", () => {
  it("maps manga cards to stable slugs and ignores chapter links", () => {
    const page = parseCatalogCards(ROKARI_CATALOG_HTML);
    assert.equal(page.items.length, 2);
    assert.equal(page.items[0]?.mangaId, "bunker-days");
    assert.equal(page.items[1]?.mangaId, "garden-of-may");
  });

  it("finds series cards on search pages", () => {
    const page = parseSearchCards(ROKARI_CATALOG_HTML);
    assert.equal(page.items.length, 2);
  });

  it("collects the live genre taxonomy", () => {
    const filters = parseFilterOptions(ROKARI_SERIES_HTML);
    assert.deepEqual(
      filters.genres.map((genre) => genre.id),
      ["drama", "martial-arts"],
    );
  });
});

describe("Rokari series parsing", () => {
  it("reads structured details while preserving the route slug", () => {
    const details = parseMangaDetails(ROKARI_SERIES_HTML, "bunker-days");
    assert.equal(details.mangaId, "bunker-days");
    assert.equal(details.mangaInfo.primaryTitle, "Bunker Days");
    assert.match(details.mangaInfo.thumbnailUrl ?? "", /bunker-cover/);
    assert.equal(details.mangaInfo.status, "Ongoing");
    assert.equal(details.mangaInfo.shareUrl, "https://rokaricomics.com/manga/bunker-days/");
  });

  it("encodes multi-word genres into valid Paperback tag IDs", () => {
    const details = parseMangaDetails(ROKARI_SERIES_HTML, "bunker-days");
    const tags = details.mangaInfo.tagGroups?.[0]?.tags ?? [];
    assert.ok(tags.some((tag) => tag.title === "Martial Arts" && tag.id === "Martial%20Arts"));
    for (const tag of tags) {
      assert.match(tag.id, /^[A-Za-z0-9._\-@()[\]%?#+=/:&]+$/);
    }
  });

  it("reads data-num chapters newest first with deterministic dates", () => {
    const chapters = parseChapters(ROKARI_SERIES_HTML, sourceManga("bunker-days"));
    assert.equal(chapters.length, 2);
    assert.equal(chapters[0]?.chapterId, "bunker-days-chapter-38");
    assert.equal(chapters[0]?.chapNum, 38);
    assert.equal(chapters[0]?.sortingIndex, 0);
    assert.equal(chapters[1]?.chapterId, "bunker-days-chapter-37");
  });
});

describe("Rokari reader parsing", () => {
  it("orders direct manga upload pages and skips theme art", () => {
    const details = parseChapterDetails(ROKARI_CHAPTER_HTML, {
      sourceManga: sourceManga("bunker-days"),
      chapterId: "bunker-days-chapter-38",
      langCode: "en",
      chapNum: 38,
      title: "Chapter 38",
    });
    if (!("pages" in details)) throw new Error("Rokari reader did not return image pages.");
    assert.equal(details.pages.length, 2);
    assert.ok(details.pages.every((page: string) => page.includes("/uploads/manga/")));
  });

  it("fails clearly instead of returning a blank reader", () => {
    assert.throws(
      () =>
        parseChapterDetails(ROKARI_EMPTY_CHAPTER_HTML, {
          sourceManga: sourceManga("bunker-days"),
          chapterId: "bunker-days-chapter-38",
          langCode: "en",
          chapNum: 38,
          title: "Chapter 38",
        }),
      /returned no pages/,
    );
  });
});
