import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ContentRating, type Chapter, type SourceManga } from "@paperback/types";

import {
  parseAvailableFilters,
  parseChapters,
  parseComicChapter,
  contentRatingForAtsumaru,
  parseFeedResponse,
  parseMangaPage,
  parseMangaRatingDocument,
  parseNovelChapter,
  parseScanlators,
  parseSearchResponse,
  normalizeAtsumaruImage,
} from "./parsers.js";
import {
  AVAILABLE_FILTERS_RESPONSE,
  CHAPTERS_RESPONSE,
  COMIC_CHAPTER_RESPONSE,
  FEED_RESPONSE,
  MANGA_PAGE_RESPONSE,
  NOVEL_CHAPTER_RESPONSE,
  SEARCH_RESPONSE,
} from "./test-fixtures.js";

const sourceManga: SourceManga = {
  mangaId: "oJQ4o",
  mangaInfo: {
    primaryTitle: "Archive Hero",
    secondaryTitles: [],
    thumbnailUrl: "https://cdn.atsu.moe/static/posters/oJQ4o.webp",
    synopsis: "",
    contentRating: ContentRating.EVERYONE,
  },
};

describe("Atsumaru list parsers", () => {
  it("sorts and deduplicates filter taxonomy without changing opaque IDs", () => {
    const filters = parseAvailableFilters(AVAILABLE_FILTERS_RESPONSE);
    assert.deepEqual(filters.genres, [
      { id: "12", name: "Action" },
      { id: "4", name: "Drama" },
    ]);
    assert.deepEqual(filters.statuses, [
      { id: "1", name: "Completed" },
      { id: "2", name: "Ongoing" },
    ]);
    assert.deepEqual(filters.types, [
      { id: "Manga", name: "Manga" },
      { id: "Manwha", name: "Manwha" },
    ]);
    assert.equal(filters.tags.length, 2);
  });

  it("parses search cards, preserves IDs, and maps ratings conservatively", () => {
    const page = parseSearchResponse(SEARCH_RESPONSE);
    assert.equal(page.page, 2);
    assert.equal(page.hasNextPage, true);
    assert.deepEqual(
      page.items.map((item) => [item.mangaId, item.title, item.contentRating]),
      [
        ["7nZTg", "Safe Archive", ContentRating.EVERYONE],
        ["lwT7", "Suggestive Notes", ContentRating.MATURE],
        ["68Fv", "Adult Novel", ContentRating.ADULT],
      ],
    );
  });

  it("encodes API IDs that Paperback cannot store without changing safe IDs", () => {
    const page = parseSearchResponse({
      found: 2,
      page: 1,
      hits: [
        { document: { id: "dark-~-mage", title: "Dark Mage" } },
        { document: { id: "series.v2", title: "Version Two" } },
      ],
    });
    assert.equal(page.items[0]?.mangaId, "dark-%7E-mage");
    assert.equal(page.items[1]?.mangaId, "series.v2");

    const manga = parseMangaPage(
      {
        mangaPage: {
          id: "dark-~-mage",
          title: "Dark Mage",
          medium: "Comic",
          poster: {},
        },
      },
      "dark-%7E-mage",
    );
    assert.equal(manga.mangaId, "dark-%7E-mage");
    assert.equal(manga.mangaInfo.shareUrl, "https://atsu.moe/manga/dark-%7E-mage");
  });

  it("skips search cards whose opaque IDs cannot safely reach the request boundary", () => {
    const page = parseSearchResponse({
      found: 3,
      page: 1,
      hits: [
        { document: { id: "valid-id", title: "Valid" } },
        { document: { id: "bell\u0007id", title: "Control" } },
        { document: { id: "x".repeat(257), title: "Oversized" } },
      ],
    });

    assert.deepEqual(
      page.items.map((item) => item.mangaId),
      ["valid-id"],
    );
  });

  it("rejects integer metadata that cannot be represented without precision loss", () => {
    assert.throws(
      () => parseSearchResponse({ found: Number.MAX_SAFE_INTEGER + 1, page: 1, hits: [] }),
      /invalid search response/i,
    );
    assert.throws(
      () => parseSearchResponse({ found: 1, page: Number.MAX_SAFE_INTEGER + 1, hits: [] }),
      /invalid search response/i,
    );
  });

  it("parses feed cards and skips malformed entries", () => {
    const page = parseFeedResponse(FEED_RESPONSE);
    assert.deepEqual(
      page.items.map((item) => item.mangaId),
      ["oJQ4o", "N7JpR"],
    );
    assert.equal(page.items[0]?.imageUrl, "https://cdn.atsu.moe/static/posters/oJQ4o-medium.webp");
    assert.equal(page.items[0]?.contentRating, ContentRating.MATURE);
    assert.equal(page.items[1]?.contentRating, ContentRating.ADULT);
  });

  it("keeps URL parsing independent from the browser global and rejects unsafe images", () => {
    const browserURL = globalThis.URL;
    try {
      Object.assign(globalThis, { URL: undefined });
      assert.equal(
        normalizeAtsumaruImage("https://atsu.moe/static/posters/7nZTg.webp"),
        "https://cdn.atsu.moe/static/posters/7nZTg.webp",
      );
    } finally {
      Object.assign(globalThis, { URL: browserURL });
    }
    assert.equal(normalizeAtsumaruImage("http://atsu.moe/static/posters/x.webp"), undefined);
    assert.equal(normalizeAtsumaruImage("https://example.com/static/posters/x.webp"), undefined);
    assert.equal(normalizeAtsumaruImage("/static/../secret.webp"), undefined);
    assert.equal(normalizeAtsumaruImage("/static/posters/%25252e%25252e/secret.webp"), undefined);
    assert.equal(
      normalizeAtsumaruImage("https://atsu.moe/static/posters/x.webp?javascript=1"),
      undefined,
    );
  });
});

describe("Atsumaru manga and chapter parsers", () => {
  it("uses the authoritative Typesense rating and ignores incidental page tags", () => {
    const cases = [
      {
        id: "2VgNt",
        medium: "Comic",
        isAdult: false,
        mbContentRating: "Safe",
        tags: [{ id: "807", name: "Adult Male Character", namePath: "Character Traits > Age" }],
        expected: ContentRating.EVERYONE,
      },
      {
        id: "cDiHx",
        medium: "Comic",
        isAdult: false,
        mbContentRating: "Suggestive",
        expected: ContentRating.MATURE,
      },
      {
        id: "CM0wz",
        medium: "Comic",
        isAdult: false,
        mbContentRating: "Erotica",
        tags: [{ id: "262", name: "Gore", namePath: "Themes > Violence > Gore" }],
        expected: ContentRating.ADULT,
      },
      {
        id: "xs4Q",
        medium: "Comic",
        isAdult: true,
        mbContentRating: "Pornographic",
        expected: ContentRating.ADULT,
      },
      {
        id: "39yf",
        medium: "Novel",
        isAdult: false,
        mbContentRating: "Safe",
        tags: [{ id: "15", name: "Mature", namePath: "Sexual Content > Intensity" }],
        expected: ContentRating.EVERYONE,
      },
      {
        id: "DJqV8",
        medium: "Comic",
        isAdult: true,
        mbContentRating: "Suggestive",
        expected: ContentRating.ADULT,
      },
    ] as const;

    for (const testCase of cases) {
      const page = {
        mangaPage: {
          id: testCase.id,
          title: testCase.id,
          medium: testCase.medium,
          poster: {},
          isAdult: testCase.isAdult,
          ...("tags" in testCase && { tags: testCase.tags }),
        },
      };
      const rating = parseMangaRatingDocument(
        {
          id: testCase.id,
          isAdult: testCase.isAdult,
          mbContentRating: testCase.mbContentRating,
        },
        testCase.id,
      );
      assert.ok(rating);
      assert.equal(
        parseMangaPage(page, testCase.id, rating).mangaInfo.contentRating,
        testCase.expected,
      );
    }
  });

  it("falls back safely for missing or invalid rating documents", () => {
    const page = {
      mangaPage: {
        id: "-aOD",
        title: "The Author's POV",
        medium: "Novel",
        poster: {},
        isAdult: false,
        tags: [{ id: "15", name: "Mature Male Lead", namePath: "Character Traits > Age" }],
      },
    };
    const missing = parseMangaRatingDocument({ id: "-aOD", isAdult: false }, "-aOD");
    assert.ok(missing);
    assert.equal(
      parseMangaPage(page, "-aOD", missing).mangaInfo.contentRating,
      ContentRating.MATURE,
    );
    assert.equal(
      contentRatingForAtsumaru({
        id: "-aOD",
        isAdult: false,
        mbContentRating: "not-a-rating",
        tags: [{ name: "Adult Male Character", namePath: "Character Traits > Age" }],
      }),
      ContentRating.MATURE,
    );
    assert.equal(
      parseMangaRatingDocument({ id: "other", mbContentRating: "Pornographic" }, "-aOD"),
      undefined,
    );
  });

  it("rejects a mismatched manga response and maps a valid page", () => {
    assert.throws(() => parseMangaPage(MANGA_PAGE_RESPONSE, "N7JpR"), /mismatch/i);
    const manga = parseMangaPage(MANGA_PAGE_RESPONSE, "oJQ4o");
    assert.equal(manga.mangaId, "oJQ4o");
    assert.equal(manga.mangaInfo.contentType, "comic");
    assert.equal(manga.mangaInfo.contentRating, ContentRating.MATURE);
    assert.deepEqual(manga.mangaInfo.secondaryTitles, ["Архивный герой"]);
    assert.equal(manga.mangaInfo.author, "Jane Doe");
    assert.equal(manga.mangaInfo.artist, "John Doe");
    assert.equal(manga.mangaInfo.rating, 0.875);
    assert.equal(manga.mangaInfo.additionalInfo?.views, "10,000");
    assert.ok(manga.mangaInfo.tagGroups?.some((group) => group.id === "Content"));
  });

  it("tolerates sparse detail metadata and chooses the novel share route", () => {
    const manga = parseMangaPage(
      {
        mangaPage: {
          id: "68Fv",
          title: "Sparse Novel",
          medium: "Novel",
          poster: { image: "posters/68Fv.webp" },
        },
      },
      "68Fv",
    );
    assert.equal(manga.mangaInfo.synopsis, "");
    assert.equal(manga.mangaInfo.contentType, "novel");
    assert.equal(manga.mangaInfo.shareUrl, "https://atsu.moe/novel/68Fv");
  });

  it("uses Paperback-safe metadata group IDs without altering their titles", () => {
    const manga = parseMangaPage(
      {
        mangaPage: {
          id: "safe-id",
          title: "Grouped",
          medium: "Comic",
          poster: {},
          tags: [
            {
              id: "250",
              name: "Black-Haired Lead",
              namePath: "Character Traits > Appearance > Hair",
            },
          ],
        },
      },
      "safe-id",
    );

    assert.deepEqual(manga.mangaInfo.tagGroups, [
      {
        id: "Character%20Traits",
        title: "Character Traits",
        tags: [{ id: "250", title: "Black-Haired Lead" }],
      },
    ]);
  });

  it("extracts exact scanlator IDs and drops conflicting duplicate names", () => {
    assert.deepEqual(
      parseScanlators({
        mangaPage: {
          scanlators: [
            { id: "scan-a", name: "Archive Team" },
            { id: "scan-a", name: "Archive Team" },
            { id: "scan-b", name: "First" },
            { id: "scan-b", name: "Conflicting" },
            { name: "missing id" },
          ],
        },
      }),
      { "scan-a": "Archive Team" },
    );
  });

  it("sorts duplicate scanlations while retaining every unique opaque chapter ID", () => {
    const chapters = parseChapters(
      CHAPTERS_RESPONSE,
      sourceManga,
      parseScanlators(MANGA_PAGE_RESPONSE),
    );
    assert.deepEqual(
      chapters.map((chapter) => chapter.chapterId),
      ["h4j-gl", "wZieNneB", "_rmrsb"],
    );
    assert.deepEqual(
      chapters.map((chapter) => chapter.sortingIndex),
      [0, 1, 2],
    );
    assert.equal(chapters[1]?.version, "Archive Team");
    assert.equal(chapters[1]?.additionalInfo?.scanlationId, "scan-manga-oJQ4o");
    assert.equal(chapters[1]?.title, "The return {extra}");
    assert.equal(chapters[2]?.title, "Alternate");
  });

  it("retains chapters with optional metadata missing and strictly normalizes timestamps", () => {
    const chapters = parseChapters(
      {
        chapters: [
          { id: "missing-title", number: 1, createdAt: 1_700_000_000_000 },
          { id: "missing-date", number: 2, title: "Chapter 2" },
          { id: "seconds", number: 3, title: "Chapter 3", createdAt: "1700000000" },
          {
            id: "numeric-prefix-junk",
            number: 4,
            title: "Chapter 4",
            createdAt: "1700000000000 trailing junk",
          },
          { id: "wrong-length", number: 5, title: "Chapter 5", createdAt: 17000000000 },
        ],
      },
      sourceManga,
    );

    assert.deepEqual(
      chapters.map((chapter) => chapter.chapterId),
      ["missing-title", "missing-date", "seconds", "numeric-prefix-junk", "wrong-length"],
    );
    assert.equal("title" in chapters[0]!, false);
    assert.equal(chapters[0]?.publishDate?.getTime(), 1_700_000_000_000);
    assert.equal("publishDate" in chapters[1]!, false);
    assert.equal(chapters[2]?.publishDate?.getTime(), 1_700_000_000_000);
    assert.equal("publishDate" in chapters[3]!, false);
    assert.equal("publishDate" in chapters[4]!, false);
  });

  it("compares duplicate IDs only on mapped chapter output and fails closed on conflicts", () => {
    const chapters = parseChapters(
      {
        chapters: [
          {
            id: "equivalent",
            title: "Chapter 1",
            number: 1,
            createdAt: 1_700_000_000_000,
            index: 0,
            scanlationMangaId: "scan-a",
            pageCount: 1,
            metadata: { first: 1, nested: { value: 1 } },
            irrelevantBigInt: 1n,
          },
          {
            id: "equivalent",
            title: "Chapter 1",
            number: 1,
            createdAt: "1700000000",
            index: 0,
            scanlationMangaId: "scan-a",
            pageCount: 999,
            metadata: { nested: { value: 1 }, first: 1 },
            irrelevantBigInt: 2n,
          },
          {
            id: "conflicting-title",
            title: "Chapter 2",
            number: 2,
            createdAt: 1_700_000_000_000,
            index: 1,
          },
          {
            id: "conflicting-title",
            title: "Chapter 2 — Different",
            number: 2,
            createdAt: 1_700_000_000_000,
            index: 1,
          },
          {
            id: "conflicting-number",
            title: "Chapter 3",
            number: 3,
            createdAt: 1_700_000_000_000,
            index: 2,
          },
          {
            id: "conflicting-number",
            title: "Chapter 3",
            number: 4,
            createdAt: 1_700_000_000_000,
            index: 2,
          },
          {
            id: "conflicting-date",
            title: "Chapter 5",
            number: 5,
            createdAt: 1_700_000_000_000,
            index: 3,
          },
          {
            id: "conflicting-date",
            title: "Chapter 5",
            number: 5,
            createdAt: 1_700_000_001_000,
            index: 3,
          },
          {
            id: "conflicting-index",
            title: "Chapter 6",
            number: 6,
            createdAt: 1_700_000_000_000,
            index: 4,
          },
          {
            id: "conflicting-index",
            title: "Chapter 6",
            number: 6,
            createdAt: 1_700_000_000_000,
            index: 5,
          },
          {
            id: "conflicting-scanlation",
            title: "Chapter 7",
            number: 7,
            createdAt: 1_700_000_000_000,
            scanlationMangaId: "scan-a",
          },
          {
            id: "conflicting-scanlation",
            title: "Chapter 7",
            number: 7,
            createdAt: 1_700_000_000_000,
            scanlationMangaId: "scan-b",
          },
        ],
      },
      sourceManga,
    );

    assert.deepEqual(
      chapters.map((chapter) => chapter.chapterId),
      ["equivalent"],
    );
  });

  it("encodes chapter IDs at the Paperback boundary and decodes them for response checks", () => {
    const [chapter] = parseChapters(
      {
        chapters: [
          {
            id: "chapter~bonus",
            title: "Chapter 3 Bonus",
            number: 3,
            createdAt: 1_700_000_000_000,
          },
        ],
      },
      sourceManga,
    );
    assert.equal(chapter?.chapterId, "chapter%7Ebonus");
    assert.deepEqual(
      parseComicChapter(
        {
          readChapter: {
            id: "chapter~bonus",
            pages: [{ image: "/static/pages/bonus.webp", number: 1 }],
          },
        },
        chapter!,
      ),
      {
        id: "chapter%7Ebonus",
        mangaId: "oJQ4o",
        pages: ["https://cdn.atsu.moe/static/pages/bonus.webp"],
      },
    );
  });

  it("normalizes, sorts, deduplicates, and rejects foreign comic pages", () => {
    const chapter: Chapter = {
      chapterId: "wZieNneB",
      sourceManga,
      langCode: "en",
      chapNum: 2,
    };
    const details = parseComicChapter(COMIC_CHAPTER_RESPONSE, chapter);
    assert.deepEqual(details, {
      id: "wZieNneB",
      mangaId: "oJQ4o",
      pages: [
        "https://cdn.atsu.moe/static/pages/1.webp",
        "https://cdn.atsu.moe/static/pages/2.webp",
      ],
    });
  });

  it("requires an expected scanlation ID in both comic and novel reader responses", () => {
    const comicChapter: Chapter = {
      chapterId: "wZieNneB",
      sourceManga,
      langCode: "en",
      chapNum: 2,
      additionalInfo: { scanlationId: "scan-manga-oJQ4o" },
    };
    const novelChapter: Chapter = {
      chapterId: "zFL0iqq",
      sourceManga: { ...sourceManga, mangaId: "N7JpR" },
      langCode: "en",
      chapNum: 5,
      additionalInfo: { scanlationId: "scan-manga-N7JpR" },
    };

    assert.throws(
      () =>
        parseComicChapter(
          { readChapter: { ...COMIC_CHAPTER_RESPONSE.readChapter, scanlationMangaId: undefined } },
          comicChapter,
        ),
      /scanlation/i,
    );
    assert.throws(
      () =>
        parseComicChapter(
          { readChapter: { ...COMIC_CHAPTER_RESPONSE.readChapter, scanlationMangaId: "other" } },
          comicChapter,
        ),
      /scanlation/i,
    );
    assert.throws(
      () =>
        parseNovelChapter(
          {
            readNovelChapter: {
              ...NOVEL_CHAPTER_RESPONSE.readNovelChapter,
              scanlationMangaId: undefined,
            },
          },
          novelChapter,
        ),
      /scanlation/i,
    );
    assert.throws(
      () =>
        parseNovelChapter(
          {
            readNovelChapter: {
              ...NOVEL_CHAPTER_RESPONSE.readNovelChapter,
              scanlationMangaId: "other",
            },
          },
          novelChapter,
        ),
      /scanlation/i,
    );
  });

  it("escapes novel paragraphs as inert XHTML and validates chapter IDs", () => {
    const chapter: Chapter = {
      chapterId: "zFL0iqq",
      sourceManga: { ...sourceManga, mangaId: "N7JpR" },
      langCode: "en",
      chapNum: 5,
    };
    const details = parseNovelChapter(NOVEL_CHAPTER_RESPONSE, chapter);
    assert.equal(details.type, "html");
    if (details.type === "html") {
      assert.match(details.html, /&lt;script&gt;steal\(\)&lt;\/script&gt;/);
      assert.match(details.html, /Hello &amp; goodbye/);
      assert.doesNotMatch(details.html, /<script>/);
    }
    assert.throws(
      () =>
        parseNovelChapter(
          { readNovelChapter: { ...NOVEL_CHAPTER_RESPONSE.readNovelChapter, id: "other" } },
          chapter,
        ),
      /mismatch/i,
    );
  });
});
