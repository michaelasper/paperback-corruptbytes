import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ContentRating } from "@paperback/types";

import {
  parseNovelDashCatalog,
  parseNovelDashChapterDetails,
  parseNovelDashGenres,
  parseNovelDashSeriesPage,
} from "./noveldash-parsers.js";
import {
  COMIC_MANGA_ID,
  NOVEL_MANGA_ID,
  NOVELDASH_TEST_SITE,
  comicReaderHtml,
  dormantProtectionComicReaderHtml,
  lockedReaderHtml,
  novelReaderHtml,
  purchasedComicReaderHtml,
  protectedComicReaderHtml,
  seriesPageHtml,
  sourceMangaFixture,
  taxonomyHtml,
} from "./noveldash-test-fixtures.js";

describe("NovelDash catalog parsing", () => {
  it("maps media, ratings, mature genres, and the newest free chapter", () => {
    const page = parseNovelDashCatalog(
      {
        data: [
          {
            id: "series-1",
            slug: "misleading-internal-slug",
            urlSlug: "route-slug",
            title: "Fixture Comic",
            coverImage: "/uploads/cover.webp",
            type: "MANHWA",
            status: "ONGOING",
            rating: 8.5,
            isMature: false,
            genres: [{ genre: { slug: "adult" } }, { genre: { slug: "fantasy" } }],
            chapters: [
              {
                id: "locked-3",
                number: 3,
                title: "Chapter 3",
                isLocked: true,
                isFree: false,
              },
              {
                id: "free-2",
                number: 2,
                title: "Chapter 2",
                isLocked: false,
                isFree: true,
                publishedAt: "2026-01-02T00:00:00.000Z",
              },
            ],
          },
        ],
        meta: { total: 31, page: 1, limit: 24, totalPages: 2, hasMore: true },
      },
      NOVELDASH_TEST_SITE,
    );

    assert.equal(page.items[0]?.mangaId, COMIC_MANGA_ID);
    assert.equal(page.items[0]?.imageUrl, "https://media.fixture.example/uploads/cover.webp");
    assert.equal(page.items[0]?.rating, 0.85);
    assert.equal(page.items[0]?.contentRating, ContentRating.ADULT);
    assert.equal(page.items[0]?.latestChapterId, "free-2");
    assert.equal(page.hasMore, true);
  });

  it("omits DMCA-taken-down cards", () => {
    const page = parseNovelDashCatalog(
      {
        data: [{ slug: "removed", title: "Removed", dmcaTakenDown: true }],
        meta: { total: 1, page: 1, totalPages: 1 },
      },
      NOVELDASH_TEST_SITE,
    );
    assert.deepEqual(page.items, []);
  });
});

describe("NovelDash series parsing", () => {
  it("parses metadata while preserving route and internal slugs separately", () => {
    const page = parseNovelDashSeriesPage(
      seriesPageHtml({ kind: "novel" }),
      NOVELDASH_TEST_SITE,
      NOVEL_MANGA_ID,
      { showLocked: true },
    );

    assert.equal(page.sourceManga.mangaInfo.primaryTitle, "Fixture Novel");
    assert.equal(page.sourceManga.mangaInfo.author, "Fixture Author");
    assert.equal(page.sourceManga.mangaInfo.contentType, "novel");
    assert.equal(page.sourceManga.mangaInfo.contentRating, ContentRating.ADULT);
    assert.equal(page.sourceManga.mangaInfo.additionalInfo?.routeSlug, "novel-route");
    assert.equal(page.sourceManga.mangaInfo.additionalInfo?.internalSlug, "misleading-reader-slug");
    assert.equal(page.chapters[1]?.title, "🔒 Locked — 50 coins • A paid chapter");
    assert.equal(page.chapters[1]?.additionalInfo?.isAccessible, "false");
  });

  it("can hide locked chapters without renumbering identities", () => {
    const page = parseNovelDashSeriesPage(seriesPageHtml(), NOVELDASH_TEST_SITE, COMIC_MANGA_ID, {
      showLocked: false,
    });
    assert.deepEqual(
      page.chapters.map((chapter) => chapter.chapterId),
      ["chapter-1"],
    );
  });

  it("selects the full live taxonomy rather than nested card genres", () => {
    assert.deepEqual(parseNovelDashGenres(taxonomyHtml, NOVELDASH_TEST_SITE), [
      { id: "adult", title: "Adult" },
      { id: "drama", title: "Drama" },
      { id: "fantasy", title: "Fantasy" },
    ]);
  });
});

describe("NovelDash reader parsing", () => {
  it("orders validated comic pages", () => {
    const chapter = parseNovelDashSeriesPage(seriesPageHtml(), NOVELDASH_TEST_SITE, COMIC_MANGA_ID)
      .chapters[0]!;
    const details = parseNovelDashChapterDetails(comicReaderHtml, chapter, NOVELDASH_TEST_SITE);
    assert.deepEqual(details, {
      id: "chapter-1",
      mangaId: COMIC_MANGA_ID,
      pages: [
        "https://media.fixture.example/series/route-slug/0001/page-1.webp",
        "https://media.fixture.example/series/route-slug/0001/page-2.webp",
      ],
    });
  });

  it("returns sanitized XHTML for novel text references", () => {
    const chapter = {
      chapterId: "novel-chapter-1",
      sourceManga: sourceMangaFixture("novel"),
      langCode: "en",
      chapNum: 1,
      additionalInfo: { upstreamId: "novel-chapter-1", number: "1" },
    };
    const details = parseNovelDashChapterDetails(
      novelReaderHtml(
        '<div onclick="steal()"><p>Hello <strong>reader</strong>.</p><script>bad()</script><iframe src="https://evil.example"></iframe></div>',
      ),
      chapter,
      NOVELDASH_TEST_SITE,
    );
    assert.equal(details.type, "html");
    if (details.type !== "html") assert.fail("Expected novel details");
    assert.match(details.html, /Hello <strong>reader<\/strong>\./);
    assert.doesNotMatch(details.html, /script|iframe|onclick/i);
  });

  it("rejects inaccessible paid chapters even when their payload contains image URLs", () => {
    const chapter = parseNovelDashSeriesPage(seriesPageHtml(), NOVELDASH_TEST_SITE, COMIC_MANGA_ID)
      .chapters[1]!;
    assert.throws(
      () => parseNovelDashChapterDetails(lockedReaderHtml, chapter, NOVELDASH_TEST_SITE),
      /locked.*50 coins.*sign in/i,
    );
  });

  it("rejects a reader response for a different chapter identity", () => {
    const chapter = parseNovelDashSeriesPage(seriesPageHtml(), NOVELDASH_TEST_SITE, COMIC_MANGA_ID)
      .chapters[0]!;
    assert.throws(
      () => parseNovelDashChapterDetails(lockedReaderHtml, chapter, NOVELDASH_TEST_SITE),
      /different chapter/i,
    );
  });

  it("rejects protected page layouts instead of returning scrambled images", () => {
    const chapter = parseNovelDashSeriesPage(seriesPageHtml(), NOVELDASH_TEST_SITE, COMIC_MANGA_ID)
      .chapters[0]!;
    assert.throws(
      () => parseNovelDashChapterDetails(protectedComicReaderHtml, chapter, NOVELDASH_TEST_SITE),
      /protected page layout/i,
    );
  });

  it("uses complete direct images when dormant protection metadata is present", () => {
    const chapter = parseNovelDashSeriesPage(seriesPageHtml(), NOVELDASH_TEST_SITE, COMIC_MANGA_ID)
      .chapters[0]!;
    const details = parseNovelDashChapterDetails(
      dormantProtectionComicReaderHtml,
      chapter,
      NOVELDASH_TEST_SITE,
    );

    assert.ok("pages" in details);
    if ("pages" in details) assert.equal(details.pages.length, 2);
  });

  it("lets an explicit account unlock override paid chapter metadata", () => {
    const sourceChapter = parseNovelDashSeriesPage(
      seriesPageHtml(),
      NOVELDASH_TEST_SITE,
      COMIC_MANGA_ID,
    ).chapters[0]!;
    const chapter = {
      ...sourceChapter,
      additionalInfo: {
        ...sourceChapter.additionalInfo,
        isLocked: "true",
        isAccessible: "true",
        coinPrice: "50",
      },
    };
    const details = parseNovelDashChapterDetails(
      purchasedComicReaderHtml,
      chapter,
      NOVELDASH_TEST_SITE,
    );

    assert.ok("pages" in details);
    if ("pages" in details) assert.equal(details.pages.length, 2);
  });
});
