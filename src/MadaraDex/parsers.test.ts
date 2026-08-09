import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ContentRating, type Chapter, type SourceManga } from "@paperback/types";

import {
  parseCatalogCards,
  parseCatalogPage,
  parseChapterDetails,
  parseChapters,
  parseDate,
  parseFilterOptions,
  parseMangaDetails,
  parseNumericMangaId,
} from "./parsers.js";
import {
  DIRECTORY_HTML,
  FILTERS_HTML,
  NOVEL_READER_HTML,
  READER_HTML,
  SEARCH_HTML,
  SERIES_HTML,
} from "./test-fixtures.js";

const sourceManga: SourceManga = {
  mangaId: "2872",
  mangaInfo: {
    primaryTitle: "Savage Hero",
    secondaryTitles: [],
    thumbnailUrl: "https://madaradex.org/wp-content/uploads/2872.webp",
    synopsis: "",
    contentRating: ContentRating.ADULT,
    shareUrl: "https://madaradex.org/title/savage-hero/",
  },
};

describe("MadaraDex catalog parsers", () => {
  it("extracts stable numeric IDs from both listing and search markup", () => {
    const directory = parseCatalogCards(DIRECTORY_HTML);
    const search = parseCatalogCards(SEARCH_HTML);

    assert.deepEqual(directory, [
      {
        mangaId: "574",
        title: "Magic Emperor",
        imageUrl: "https://madaradex.org/wp-content/uploads/574.webp",
        contentRating: ContentRating.MATURE,
        rating: 0.8,
        latestChapterId: "chapter-894",
        latestChapterTitle: "Chapter 894",
      },
      {
        mangaId: "622",
        title: "Adult Series",
        imageUrl: "https://madaradex.org/wp-content/uploads/622.webp",
        contentRating: ContentRating.ADULT,
      },
    ]);
    assert.equal(search[0]?.mangaId, "2947");
    assert.equal(search[0]?.title, "Magical Girl Wife");
    assert.equal(search[0]?.contentRating, ContentRating.MATURE);
    assert.equal(parseNumericMangaId('<link rel="shortlink" href="/?p=2872">'), "2872");
    assert.equal(parseNumericMangaId("<html></html>"), undefined);
  });

  it("detects pagination and parses exact filter values", () => {
    assert.equal(parseCatalogPage(DIRECTORY_HTML).hasNextPage, true);
    assert.deepEqual(parseFilterOptions(FILTERS_HTML), {
      genres: [
        { id: "action", title: "Action" },
        { id: "martial-arts", title: "Martial Arts" },
        { id: "mature", title: "Mature" },
      ],
      statuses: [
        { id: "on-going", title: "Ongoing" },
        { id: "end", title: "Completed" },
      ],
    });
  });
});

describe("MadaraDex title and reader parsers", () => {
  it("parses chapter URLs without the browser URL global", () => {
    const browserURL = globalThis.URL;
    try {
      Object.assign(globalThis, { URL: undefined });
      assert.deepEqual(
        parseChapters(SERIES_HTML, sourceManga).map((chapter) => chapter.chapterId),
        ["chapter-0", "chapter-1-1", "chapter-2"],
      );
    } finally {
      Object.assign(globalThis, { URL: browserURL });
    }
  });

  it("parses complete series metadata without changing the archived ID", () => {
    const result = parseMangaDetails(SERIES_HTML, "2872");
    assert.equal(result.mangaId, "2872");
    assert.equal(result.mangaInfo.primaryTitle, "Savage Hero");
    assert.deepEqual(result.mangaInfo.secondaryTitles, ["Incubus of Frustration", "鬼畜英雄"]);
    assert.equal(
      result.mangaInfo.thumbnailUrl,
      "https://madaradex.org/wp-content/uploads/2872.webp",
    );
    assert.equal(result.mangaInfo.author, "Yonoki");
    assert.equal(result.mangaInfo.artist, "Yonoki");
    assert.equal(result.mangaInfo.status, "Ongoing");
    assert.equal(result.mangaInfo.rating, 0.8);
    assert.equal(result.mangaInfo.contentRating, ContentRating.ADULT);
    assert.equal(result.mangaInfo.synopsis, "A brutal & funny story.");
    assert.equal(result.mangaInfo.shareUrl, "https://madaradex.org/title/savage-hero/");
    assert.deepEqual(result.mangaInfo.tagGroups?.[0]?.tags, [
      { id: "Action", title: "Action" },
      { id: "Mature", title: "Mature" },
      { id: "School%20Life", title: "School Life" },
    ]);
  });

  it("parses dates deterministically and never fabricates invalid dates", () => {
    assert.equal(parseDate("June 25, 2026")?.toISOString(), "2026-06-25T00:00:00.000Z");
    assert.equal(parseDate("Mar 13, 2026")?.toISOString(), "2026-03-13T00:00:00.000Z");
    assert.equal(parseDate("not a date"), undefined);
  });

  it("preserves archived chapter IDs, fractions, titles, URLs, and stable sorting", () => {
    const chapters = parseChapters(SERIES_HTML, sourceManga);
    assert.deepEqual(
      chapters.map((chapter) => ({
        id: chapter.chapterId,
        number: chapter.chapNum,
        title: chapter.title,
        index: chapter.sortingIndex,
        url: chapter.additionalInfo?.url,
      })),
      [
        {
          id: "chapter-0",
          number: 0,
          title: "Prologue",
          index: 0,
          url: "https://madaradex.org/title/savage-hero/chapter-0/",
        },
        {
          id: "chapter-1-1",
          number: 1.1,
          title: "Extra",
          index: 1,
          url: "https://madaradex.org/title/savage-hero/chapter-1-1/",
        },
        {
          id: "chapter-2",
          number: 2,
          title: undefined,
          index: 2,
          url: "https://madaradex.org/title/savage-hero/chapter-2/",
        },
      ],
    );
    assert.equal(chapters[1]?.publishDate, undefined);
    assert.equal(chapters[2]?.publishDate?.toISOString(), "2026-06-25T00:00:00.000Z");
  });

  it("deduplicates safe image pages and sanitizes novel XHTML", async () => {
    const chapter: Chapter = {
      chapterId: "chapter-2",
      sourceManga,
      langCode: "en",
      chapNum: 2,
    };
    assert.deepEqual(await parseChapterDetails(READER_HTML, chapter), {
      id: "chapter-2",
      mangaId: "2872",
      pages: [
        "https://cdn.madaradex.org/manga_abc/chapter-2/1.webp",
        "https://cdn.madaradex.org/manga_abc/chapter-2/2.webp",
      ],
    });

    const novel = await parseChapterDetails(NOVEL_READER_HTML, chapter);
    assert.equal(novel.type, "html");
    if (novel.type === "html") {
      assert.match(novel.html, /Hello &amp; goodbye\./);
      assert.doesNotMatch(novel.html, /script|steal/i);
    }
    await assert.rejects(parseChapterDetails("<html></html>", chapter), /no readable/i);
  });
});
