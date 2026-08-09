import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ContentRating, type Chapter, type SourceManga } from "@paperback/types";

import {
  parseAutocompleteResults,
  parseChapterDetails,
  parseChapterList,
  parseDirectoryPage,
  parseGenres,
  parseHomeFeed,
  parseMangaDetails,
} from "./parsers.js";
import {
  AUTOCOMPLETE_RESPONSE,
  COMIC_READER_HTML,
  DIRECTORY_HTML,
  HOME_HTML,
  LOCKED_READER_HTML,
  NOVEL_READER_HTML,
  SERIES_HTML,
} from "./test-fixtures.js";

const manga: SourceManga = {
  mangaId: "storm-architect",
  mangaInfo: {
    primaryTitle: "Storm Architect",
    secondaryTitles: [],
    thumbnailUrl: "https://en-thunderscans.com/covers/storm-full.jpg",
    synopsis: "",
    contentRating: ContentRating.MATURE,
  },
};

const chapter = (overrides: Partial<Chapter> = {}): Chapter => ({
  chapterId: "2.5",
  sourceManga: manga,
  langCode: "en",
  chapNum: 2.5,
  additionalInfo: { url: "https://en-thunderscans.com/storm-architect-chapter-2-5/" },
  ...overrides,
});

describe("Thunder list parsers", () => {
  it("parses directory cards, stable slug IDs, ratings, and pagination", () => {
    const page = parseDirectoryPage(DIRECTORY_HTML);

    assert.equal(page.items.length, 2);
    assert.deepEqual(page.items[0], {
      mangaId: "storm-architect",
      title: "Storm Architect",
      imageUrl: "https://en-thunderscans.com/covers/storm%20architect.webp",
      contentRating: ContentRating.MATURE,
      rating: 0.92,
      status: "Ongoing",
      subtitle: "Ongoing",
    });
    assert.equal(page.hasNextPage, true);
  });

  it("extracts the live genre IDs and labels without sharing mutable state", () => {
    const first = parseGenres(DIRECTORY_HTML);
    const second = parseGenres(DIRECTORY_HTML);

    assert.deepEqual(first, [
      { id: "10", title: "Action" },
      { id: "20", title: "Adult" },
    ]);
    first[0]!.title = "Changed";
    assert.equal(second[0]?.title, "Action");
  });

  it("isolates every home feed and keeps each feed's server cursor", () => {
    const popular = parseHomeFeed(HOME_HTML, "popular");
    const editors = parseHomeFeed(HOME_HTML, "editors");
    const comics = parseHomeFeed(HOME_HTML, "latestComics");
    const novels = parseHomeFeed(HOME_HTML, "latestNovels");

    assert.deepEqual(
      popular.items.map((item) => item.mangaId),
      ["popular-storm"],
    );
    assert.deepEqual(
      editors.items.map((item) => item.mangaId),
      ["editors-orbit"],
    );
    assert.equal(editors.items[0]?.latestChapterId, "12.5");
    assert.equal(comics.items[0]?.latestChapterId, "44");
    assert.equal(comics.nextPage, 2);
    assert.equal(novels.items[0]?.contentType, "novel");
    assert.equal(novels.nextPage, 3);
  });

  it("maps structured autocomplete and applies advanced filters accurately", () => {
    const all = parseAutocompleteResults(AUTOCOMPLETE_RESPONSE);
    const novels = parseAutocompleteResults(AUTOCOMPLETE_RESPONSE, {
      status: ["completed"],
      type: ["novel"],
      genres: { Fantasy: "included", Gore: "excluded" },
    });

    assert.deepEqual(
      all.map((item) => item.mangaId),
      ["storm-architect", "quiet-thunder-novel"],
    );
    assert.deepEqual(
      novels.map((item) => item.mangaId),
      ["quiet-thunder-novel"],
    );
    assert.equal(all[0]?.contentRating, ContentRating.MATURE);
  });
});

describe("Thunder title and chapter parsers", () => {
  it("preserves requested legacy IDs while returning complete source metadata", () => {
    const result = parseMangaDetails(SERIES_HTML, "4242");

    assert.equal(result.mangaId, "4242");
    assert.equal(result.mangaInfo.primaryTitle, "Storm Architect");
    assert.deepEqual(result.mangaInfo.secondaryTitles, ["폭풍 설계자", "Architect of Storms"]);
    assert.equal(result.mangaInfo.contentType, "comic");
    assert.equal(result.mangaInfo.contentRating, ContentRating.MATURE);
    assert.equal(result.mangaInfo.status, "Ongoing");
    assert.equal(result.mangaInfo.author, "R. Vale");
    assert.equal(result.mangaInfo.artist, "Blue Current");
    assert.equal(result.mangaInfo.rating, 0.94);
    assert.equal(result.mangaInfo.additionalInfo?.slug, "storm-architect");
    assert.equal(result.mangaInfo.additionalInfo?.postId, "4242");
    assert.match(result.mangaInfo.synopsis, /Every design has a cost\./);
  });

  it("keeps numeric chapter IDs, exact URLs, purchase access, and lock metadata", () => {
    const chapters = parseChapterList(SERIES_HTML, manga, { showLocked: true });

    assert.deepEqual(
      chapters.map((item) => item.chapterId),
      ["1", "2.5", "3"],
    );
    assert.deepEqual(
      chapters.map((item) => item.sortingIndex),
      [0, 1, 2],
    );
    assert.equal(chapters[1]?.title, "Aftershock");
    assert.equal(chapters[1]?.additionalInfo?.locked, "false");
    assert.equal(chapters[1]?.additionalInfo?.price, "10");
    assert.equal(
      chapters[1]?.additionalInfo?.url,
      "https://en-thunderscans.com/storm-architect-chapter-2-5/",
    );
    assert.equal(chapters[2]?.title, "🔒 30 coins");
    assert.equal(chapters[2]?.additionalInfo?.locked, "true");
    assert.equal(chapters[2]?.additionalInfo?.postId, "9003");
    assert.ok(chapters[0]?.publishDate instanceof Date);
  });

  it("can hide unavailable paid chapters without hiding purchased ones", () => {
    const chapters = parseChapterList(SERIES_HTML, manga, { showLocked: false });
    assert.deepEqual(
      chapters.map((item) => item.chapterId),
      ["1", "2.5"],
    );
  });

  it("keeps lock and normalized coin metadata visible when a locked chapter has a title", () => {
    const titledLockedChapter = SERIES_HTML.replace('data-coin="30"', "")
      .replace("Chapter 3</span>", "Chapter 3 - Finale</span>")
      .replace(">30</span>", ">30 coins</span>");

    const chapters = parseChapterList(titledLockedChapter, manga, { showLocked: true });

    assert.equal(chapters[2]?.title, "🔒 30 coins • Finale");
    assert.equal(chapters[2]?.additionalInfo?.price, "30");
  });

  it("preserves reader source order and ignores unsafe image URLs", () => {
    const html = COMIC_READER_HTML.replace(
      '"javascript:alert(1)"',
      '"javascript:alert(1)","http://cdn.example/insecure.webp"',
    );
    const result = parseChapterDetails(html, chapter());

    assert.deepEqual(result, {
      id: "2.5",
      mangaId: "storm-architect",
      pages: [
        "https://cdn.example/page-03.webp",
        "https://en-thunderscans.com/pages/page%2002.webp",
        "https://en-thunderscans.com/pages/page-01.webp",
      ],
    });
  });

  it("falls back to the first non-empty reader source when the preferred source is empty", () => {
    const html = `<script>ts_reader.run({"defaultSource":"high","sources":[{"source":"high","images":[]},{"source":"low","images":["/pages/fallback.webp"]}]});</script>`;

    assert.deepEqual(parseChapterDetails(html, chapter()), {
      id: "2.5",
      mangaId: "storm-architect",
      pages: ["https://en-thunderscans.com/pages/fallback.webp"],
    });
  });

  it("returns sanitized XHTML for novels", () => {
    const result = parseChapterDetails(NOVEL_READER_HTML, chapter({ chapterId: "8", chapNum: 8 }));

    assert.equal(result.type, "html");
    if (result.type !== "html") assert.fail("Expected an HTML chapter");
    assert.match(result.html, /synthetic storm began/);
    assert.match(result.html, /https:\/\/en-thunderscans\.com\/glossary\//);
    assert.doesNotMatch(result.html, /script|stealCookies/i);
  });

  it("surfaces a clear error for content that remains locked", () => {
    assert.throws(
      () => parseChapterDetails(LOCKED_READER_HTML, chapter()),
      /locked.*Thunder.*sign in|sign in.*locked/i,
    );
  });
});
