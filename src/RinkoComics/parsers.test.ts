import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ContentRating } from "@paperback/types";

import { DOMAIN } from "./network.js";
import {
  parseAjaxChapterRows,
  parseArchiveCatalogPage,
  parseChapterDetails,
  parseGenrePage,
  parseRestCatalogPage,
  parseRestSeriesLookup,
  parseRinkoDate,
  parseSeriesDocument,
  sameArchiveQueryItems,
} from "./parsers.js";
import {
  AJAX_ROWS,
  ARCHIVE_HTML,
  EMPTY_AJAX_ROWS,
  GENRE_RESPONSE,
  READER_HTML,
  REST_CATALOG,
  REST_HEADERS,
  SERIES_HTML,
  SHORT_SERIES_HTML,
} from "./test-fixtures.js";

const MANGA_ID = "fixture-flower-path@900";
const CHAPTER_ID = "fixture-flower-path-chapter-12@1012";
const SITE_TITLE = "Fixture Flower Path Chapter 12";

const clone = <T>(value: T): T => structuredClone(value);

describe("Rinko Comics REST parsers", () => {
  it("parses bounded catalog rows with stable composite IDs and embedded metadata", () => {
    const page = parseRestCatalogPage(REST_CATALOG, REST_HEADERS, 1);
    assert.equal(page.totalCount, 2);
    assert.equal(page.pageCount, 1);
    assert.equal(page.hasNextPage, false);
    assert.deepEqual(page.items[0], {
      mangaId: MANGA_ID,
      slug: "fixture-flower-path",
      postId: "900",
      title: "Fixture Flower Path",
      imageUrl: "https://rinkocomics.com/wp-content/uploads/2026/01/fixture-flower-path.webp",
      genres: ["Action"],
      contentRating: ContentRating.MATURE,
    });
    assert.equal(
      parseRestSeriesLookup([REST_CATALOG[0]], "fixture-flower-path")?.mangaId,
      MANGA_ID,
    );
    assert.equal(parseRestSeriesLookup([], "missing"), undefined);
  });

  it("requires exact totals, page counts, identities, links, and embedded terms", () => {
    assert.throws(
      () => parseRestCatalogPage(REST_CATALOG, { ...REST_HEADERS, "x-wp-total": "3" }, 1),
      /inconsistent catalog pagination/i,
    );
    assert.throws(
      () => parseRestCatalogPage(REST_CATALOG, { ...REST_HEADERS, "X-WP-Total": "2" }, 1),
      /invalid response headers/i,
    );
    assert.throws(
      () => parseRestCatalogPage(REST_CATALOG, { ...REST_HEADERS, "x-wp-totalpages": "2" }, 1),
      /inconsistent catalog pagination/i,
    );
    assert.throws(() => parseRestCatalogPage(REST_CATALOG, {}, 1), /invalid paginated catalog/i);
    assert.throws(
      () => parseRestCatalogPage(REST_CATALOG, REST_HEADERS, "1" as unknown as number),
      /invalid paginated catalog/i,
    );

    const hiddenRows = clone(REST_CATALOG);
    Object.defineProperty(hiddenRows, "token", { value: "secret", enumerable: false });
    assert.throws(
      () => parseRestCatalogPage(hiddenRows, REST_HEADERS, 1),
      /invalid paginated catalog/i,
    );

    const symbolRows = clone(REST_CATALOG);
    Object.defineProperty(symbolRows, Symbol("token"), { value: "secret", enumerable: true });
    assert.throws(
      () => parseRestCatalogPage(symbolRows, REST_HEADERS, 1),
      /invalid paginated catalog/i,
    );

    const foreign = clone(REST_CATALOG);
    foreign[0]!.link = "https://evil.example/comic/fixture-flower-path/";
    assert.throws(() => parseRestCatalogPage(foreign, REST_HEADERS, 1), /foreign or mismatched/i);

    const mismatchedGenre = clone(REST_CATALOG);
    mismatchedGenre[0]!.comics_genres = [999];
    assert.throws(
      () => parseRestCatalogPage(mismatchedGenre, REST_HEADERS, 1),
      /inconsistent embedded genres/i,
    );

    const foreignCover = clone(REST_CATALOG);
    foreignCover[0]!._embedded["wp:featuredmedia"][0]!.source_url =
      "https://evil.example/cover.webp";
    assert.throws(() => parseRestCatalogPage(foreignCover, REST_HEADERS, 1), /untrusted cover/i);

    const duplicateRoute = clone([REST_CATALOG[0], REST_CATALOG[0]]);
    duplicateRoute[1]!.id = 901;
    assert.throws(
      () => parseRestCatalogPage(duplicateRoute, REST_HEADERS, 1),
      /duplicate catalog entries/i,
    );
  });

  it("parses and validates the complete genre taxonomy", () => {
    const page = parseGenrePage(GENRE_RESPONSE, REST_HEADERS, 1);
    assert.deepEqual(
      page.genres.map(({ id, title, count }) => ({ id, title, count })),
      [
        { id: "action", title: "Action", count: 8 },
        { id: "romance", title: "Romance", count: 315 },
      ],
    );

    const duplicate = [...GENRE_RESPONSE, GENRE_RESPONSE[0]];
    assert.throws(
      () =>
        parseGenrePage(
          duplicate,
          {
            ...REST_HEADERS,
            "x-wp-total": "3",
            "x-wp-totalpages": "1",
          },
          1,
        ),
      /duplicate genres/i,
    );
    const foreign = clone(GENRE_RESPONSE);
    foreign[0]!.link = "https://evil.example/comics_genres/action/";
    assert.throws(() => parseGenrePage(foreign, REST_HEADERS, 1), /invalid genre entry/i);
    const queryBearing = clone(GENRE_RESPONSE);
    queryBearing[0]!.link = "https://rinkocomics.com/comics_genres/action/?token=secret";
    assert.throws(() => parseGenrePage(queryBearing, REST_HEADERS, 1), /invalid genre entry/i);
  });
});

describe("Rinko Comics HTML parsers", () => {
  it("parses the archive card contract and rejects untrusted cards", () => {
    const page = parseArchiveCatalogPage(ARCHIVE_HTML, 1, `${DOMAIN}/comic/page/2/`);
    assert.equal(page.hasNextPage, false);
    assert.equal(page.items[0]?.mangaId, MANGA_ID);
    assert.equal(page.items[0]?.contentRating, ContentRating.MATURE);
    assert.equal(
      parseArchiveCatalogPage(
        `${ARCHIVE_HTML}<div class="ac-pagination"></div>`,
        1,
        `${DOMAIN}/comic/page/2/`,
      ).hasNextPage,
      false,
    );
    assert.throws(
      () =>
        parseArchiveCatalogPage(
          `${ARCHIVE_HTML}<div class="ac-pagination"></div>`,
          2,
          `${DOMAIN}/comic/page/3/`,
        ),
      /wrong catalog page/i,
    );
    assert.throws(
      () =>
        parseArchiveCatalogPage(
          `${ARCHIVE_HTML}<div class="ac-pagination"><span class="page-numbers current">1</span><a class="next page-numbers" href="${DOMAIN}/comic/page/2/?token=secret">Next</a></div>`,
          1,
          `${DOMAIN}/comic/page/2/`,
        ),
      /inconsistent next-page link/i,
    );
    const fullPage = Array.from({ length: 20 }, (_, index) =>
      ARCHIVE_HTML.replaceAll("fixture-flower-path", `fixture-flower-path-${index + 1}`).replace(
        'data-id="900"',
        `data-id="${index + 1}"`,
      ),
    ).join("");
    const reorderedNext = `${fullPage}<div class="ac-pagination"><span class="page-numbers current">1</span><a class="next page-numbers" href="${DOMAIN}/comic/page/2/?s=hero&amp;sort=az&amp;post_type=comic">Next</a></div>`;
    assert.equal(
      parseArchiveCatalogPage(
        reorderedNext,
        1,
        `${DOMAIN}/comic/page/2/?post_type=comic&s=hero&sort=az`,
      ).hasNextPage,
      true,
    );
    const indexedGenreNext = `${fullPage}<div class="ac-pagination"><span class="page-numbers current">1</span><a class="next page-numbers" href="${DOMAIN}/comic/page/2/?genres%5B0%5D=fantasy&amp;genres%5B1%5D=romance&amp;sort=az&amp;post_type=comic">Next</a></div>`;
    assert.equal(
      parseArchiveCatalogPage(
        indexedGenreNext,
        1,
        `${DOMAIN}/comic/page/2/?post_type=comic&genres%5B%5D=fantasy&genres%5B%5D=romance&sort=az`,
      ).hasNextPage,
      true,
    );
    const lastPage = `${fullPage}<div class="ac-pagination"><span class="page-numbers current">500</span></div>`;
    assert.equal(parseArchiveCatalogPage(lastPage, 500, undefined).hasNextPage, false);
    assert.throws(
      () =>
        parseArchiveCatalogPage(
          lastPage.replace(
            "</span></div>",
            `</span><a class="next page-numbers" href="${DOMAIN}/comic/page/501/">Next</a></div>`,
          ),
          500,
          undefined,
        ),
      /inconsistent next-page link/i,
    );
    const tokenNext = `${fullPage}<div class="ac-pagination"><span class="page-numbers current">1</span><a class="next page-numbers" href="${DOMAIN}/comic/page/2/?token=secret">Next</a></div>`;
    assert.throws(
      () => parseArchiveCatalogPage(tokenNext, 1, `${DOMAIN}/comic/page/2/?token=secret`),
      /catalog page is invalid/i,
    );

    assert.throws(
      () =>
        parseArchiveCatalogPage(
          ARCHIVE_HTML.replace("rinkocomics.com/comic/", "evil.example/comic/"),
          1,
          `${DOMAIN}/comic/page/2/`,
        ),
      /invalid catalog card link/i,
    );
    assert.throws(
      () =>
        parseArchiveCatalogPage(
          ARCHIVE_HTML.replace('data-id="900"', 'data-id="0"'),
          1,
          `${DOMAIN}/comic/page/2/`,
        ),
      /invalid catalog card link/i,
    );
    assert.throws(
      () =>
        parseArchiveCatalogPage(
          ARCHIVE_HTML.replace(
            "</h2>",
            `<a href="${DOMAIN}/comic/fixture-flower-path/">duplicate</a></h2>`,
          ),
          1,
          `${DOMAIN}/comic/page/2/`,
        ),
      /invalid catalog card link/i,
    );
    assert.throws(
      () =>
        parseArchiveCatalogPage(
          `${ARCHIVE_HTML}${ARCHIVE_HTML.replace('data-id="900"', 'data-id="901"')}`,
          1,
          `${DOMAIN}/comic/page/2/`,
        ),
      /duplicate catalog cards/i,
    );
  });

  it("rejects inherited and hostile archive query maps without leaking runtime errors", () => {
    const clean = { queryItems: { sort: "az" } };
    const inheritedItems = Object.create({ token: "secret" }) as Record<string, string>;
    inheritedItems.sort = "az";
    assert.equal(sameArchiveQueryItems({ queryItems: inheritedItems }, clean), false);
    const inheritedBearing = Object.create({ queryItems: { sort: "az" } }) as {
      queryItems?: Record<string, string | string[]>;
    };
    assert.equal(sameArchiveQueryItems(inheritedBearing, clean), false);
    assert.equal(
      sameArchiveQueryItems(
        { queryItems: 7 as unknown as Record<string, string> },
        { queryItems: 7 as unknown as Record<string, string> },
      ),
      false,
    );
    const symbolItems = { sort: "az" } as Record<PropertyKey, string>;
    Object.defineProperty(symbolItems, Symbol("token"), { value: "secret", enumerable: true });
    assert.equal(
      sameArchiveQueryItems(
        { queryItems: symbolItems as Record<string, string> },
        { queryItems: { sort: "az" } },
      ),
      false,
    );
    const hostileItems = new Proxy<Record<string, string>>(
      {},
      {
        ownKeys() {
          throw new Error("secret-token");
        },
      },
    );
    assert.equal(sameArchiveQueryItems({ queryItems: hostileItems }, clean), false);
  });

  it("parses complete series metadata and a fresh exact AJAX context", () => {
    const result = parseSeriesDocument(SERIES_HTML, MANGA_ID);
    assert.equal(result.chapterCount, 12);
    assert.equal(result.initialRows.length, 10);
    assert.equal(result.initialRows[0]?.chapterId, CHAPTER_ID);
    assert.equal(result.initialRows.find((row) => row.chapNum === 5)?.isPublic, false);
    assert.deepEqual(result.ajaxContext, {
      ajaxUrl: "https://rinkocomics.com/wp-admin/admin-ajax.php",
      nonce: "abc123DEF456",
      comicId: "900",
      seriesSlug: "fixture-flower-path",
      nextOffset: 10,
      referer: "https://rinkocomics.com/comic/fixture-flower-path/",
    });
    assert.equal(result.manga.mangaInfo.primaryTitle, "Fixture Flower Path");
    assert.deepEqual(result.manga.mangaInfo.secondaryTitles, ["Fixture Alt", "꽃길"]);
    assert.equal(result.manga.mangaInfo.author, "Fixture Author");
    assert.equal(result.manga.mangaInfo.status, "Ongoing");
    assert.equal(result.manga.mangaInfo.contentRating, ContentRating.MATURE);
    assert.equal(result.manga.mangaInfo.synopsis, "A safe & deterministic synopsis.");
    assert.equal(
      result.manga.mangaInfo.shareUrl,
      "https://rinkocomics.com/comic/fixture-flower-path/",
    );
    const duplicateCanonical = SERIES_HTML.replace(
      "</head>",
      `<link rel="canonical" href="${DOMAIN}/comic/fixture-flower-path/"></head>`,
    );
    assert.equal(parseSeriesDocument(duplicateCanonical, MANGA_ID).chapterCount, 12);

    const short = parseSeriesDocument(SHORT_SERIES_HTML, MANGA_ID);
    assert.equal(short.chapterCount, 8);
    assert.equal(short.initialRows.length, 8);
    assert.equal(short.ajaxContext, undefined);
  });

  it("requires series identity, totals, initial rows, and one exact nonce assignment", () => {
    assert.throws(
      () => parseSeriesDocument(SERIES_HTML, "different-series@900"),
      /different series/i,
    );
    assert.throws(
      () => parseSeriesDocument(SERIES_HTML.replace("<span>12</span>", "<span>2</span>"), MANGA_ID),
      /inconsistent declared chapter totals/i,
    );
    assert.throws(
      () => parseSeriesDocument(SERIES_HTML.replace("abc123DEF456", "abc-123"), MANGA_ID),
      /invalid chapter nonce/i,
    );
    assert.throws(
      () =>
        parseSeriesDocument(
          SERIES_HTML.replace(
            "</body>",
            '<script>var comicworld_ajax = {"ajax_url":"https:\\/\\/rinkocomics.com\\/wp-admin\\/admin-ajax.php","nonce":"second"};</script></body>',
          ),
          MANGA_ID,
        ),
      /invalid chapter nonce assignment/i,
    );
    assert.throws(
      () =>
        parseSeriesDocument(
          SERIES_HTML.replace('"nonce":"abc123DEF456"', '"nonce":"abc123DEF456","token":"secret"'),
          MANGA_ID,
        ),
      /invalid chapter nonce/i,
    );
    assert.throws(
      () =>
        parseSeriesDocument(
          SERIES_HTML.replace(
            '"nonce":"abc123DEF456"',
            '"nonce":"evil","\\u006eonce":"abc123DEF456"',
          ),
          MANGA_ID,
        ),
      /invalid chapter nonce assignment/i,
    );
    assert.throws(
      () =>
        parseSeriesDocument(
          SERIES_HTML.replace(
            "</head>",
            '<link rel="canonical" href="https://rinkocomics.com/comic/different-series/"></head>',
          ),
          MANGA_ID,
        ),
      /different series/i,
    );
    assert.throws(
      () =>
        parseSeriesDocument(
          SERIES_HTML.replace(
            '<button class="load-more-btn" id="loadMoreChaptersBtn" data-comic-id="900" data-offset="10"></button>',
            '<button class="load-more-btn" id="loadMoreChaptersBtn" data-comic-id="900" data-offset="10"></button><button id="loadMoreChaptersBtn" data-comic-id="900" data-offset="10"></button>',
          ),
          MANGA_ID,
        ),
      /invalid chapter pagination control/i,
    );
    assert.throws(
      () =>
        parseSeriesDocument(SERIES_HTML.replace("January 12, 2026", "Januarx 12, 2026"), MANGA_ID),
      /invalid series update date/i,
    );
    assert.throws(
      () =>
        parseSeriesDocument(
          SERIES_HTML.replace(
            "<div><div><span>Updated</span><span>January 12, 2026</span></div></div>",
            "<div><div><span>Token</span><span>secret</span></div></div>",
          ),
          MANGA_ID,
        ),
      /invalid series metadata/i,
    );
  });

  it("uses exact public access state and never trusts a locked permalink", () => {
    assert.throws(
      () =>
        parseSeriesDocument(
          SERIES_HTML.replace('data-reason="free"', 'data-reason=" free "'),
          MANGA_ID,
        ),
      /invalid chapter row/i,
    );
    const capitalizationDrift = parseSeriesDocument(
      SERIES_HTML.replace(
        'data-title="Fixture Flower Path Chapter 12"',
        'data-title="Fixture flower Path Chapter 12"',
      ),
      MANGA_ID,
    );
    assert.equal(capitalizationDrift.initialRows[0]?.siteTitle, "Fixture flower Path Chapter 12");
    assert.throws(
      () =>
        parseSeriesDocument(
          SERIES_HTML.replace(
            'data-title="Fixture Flower Path Chapter 12"',
            'data-title=" Fixture Flower Path Chapter 12 "',
          ),
          MANGA_ID,
        ),
      /invalid chapter row/i,
    );

    const foreignLocked = parseSeriesDocument(
      SERIES_HTML.replace(
        'data-reason="login_required"\n        data-permalink="https://rinkocomics.com/chapter/fixture-flower-path-chapter-5/"',
        'data-reason="login_required"\n        data-permalink="https://evil.example/private"',
      ),
      MANGA_ID,
    );
    assert.equal(foreignLocked.initialRows.find((row) => row.chapNum === 5)?.url, undefined);

    assert.throws(
      () =>
        parseSeriesDocument(
          SERIES_HTML.replace(
            'href="https://rinkocomics.com/chapter/fixture-flower-path-chapter-12/"',
            'href="https://evil.example/chapter/fixture-flower-path-chapter-12/"',
          ),
          MANGA_ID,
        ),
      /invalid public chapter link/i,
    );
  });

  it("parses bounded AJAX rows and requires explicit success", () => {
    const rows = parseAjaxChapterRows(AJAX_ROWS, "Fixture Flower Path");
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.chapNum, 2);
    assert.equal(rows[0]?.isPublic, false);
    assert.equal(rows[1]?.chapterId, "fixture-flower-path-chapter-1@1001");
    assert.equal(rows[1]?.siteTitle, "Fixture Flower Path Chapter 1");
    const capitalizationDrift = parseAjaxChapterRows(
      {
        success: true,
        data: {
          html: AJAX_ROWS.data.html.replace(
            "Fixture Flower Path Chapter 1",
            "Fixture flower Path Chapter 1",
          ),
        },
      },
      "Fixture Flower Path",
    );
    assert.equal(capitalizationDrift[1]?.siteTitle, "Fixture flower Path Chapter 1");

    const publicRowStart = AJAX_ROWS.data.html.lastIndexOf('<li class="chapter');
    assert.ok(publicRowStart >= 0);
    const publicRow = AJAX_ROWS.data.html.slice(publicRowStart);
    assert.throws(
      () =>
        parseAjaxChapterRows(
          {
            success: true,
            data: {
              html: `${publicRow}${publicRow.replace('data-post-id="1001"', 'data-post-id="1999"')}`,
            },
          },
          "Fixture Flower Path",
        ),
      /duplicate public chapter routes/i,
    );
    assert.deepEqual(parseAjaxChapterRows(EMPTY_AJAX_ROWS, "Fixture Flower Path"), []);
    assert.throws(
      () => parseAjaxChapterRows({ success: "true", data: { html: "" } }, "Fixture"),
      /invalid chapter pagination response/i,
    );
    assert.throws(
      () => parseAjaxChapterRows({ success: true, data: { html: "", token: "secret" } }, "Fixture"),
      /invalid chapter pagination response/i,
    );
    const hiddenEnvelope = Object.defineProperty({ success: true, data: { html: "" } }, "token", {
      value: "secret",
      enumerable: false,
    });
    assert.throws(
      () => parseAjaxChapterRows(hiddenEnvelope, "Fixture"),
      /invalid chapter pagination response/i,
    );
    const hiddenData = Object.defineProperty({ html: "" }, "token", {
      value: "secret",
      enumerable: false,
    });
    assert.throws(
      () => parseAjaxChapterRows({ success: true, data: hiddenData }, "Fixture"),
      /invalid chapter pagination response/i,
    );
    const symbolEnvelope = { success: true, data: { html: "" } };
    Object.defineProperty(symbolEnvelope, Symbol("token"), {
      value: "secret",
      enumerable: true,
    });
    assert.throws(
      () => parseAjaxChapterRows(symbolEnvelope, "Fixture"),
      /invalid chapter pagination response/i,
    );
    for (const html of [
      `<!-- unexpected -->${AJAX_ROWS.data.html}`,
      `${AJAX_ROWS.data.html}</ul><!-- unexpected -->`,
      `${AJAX_ROWS.data.html}</ul>unexpected`,
    ]) {
      assert.throws(
        () =>
          parseAjaxChapterRows(
            {
              success: true,
              data: { html },
            },
            "Fixture Flower Path",
          ),
        /invalid chapter pagination HTML/i,
      );
    }
    assert.throws(
      () => parseAjaxChapterRows({ success: true, data: { html: "x".repeat(300_000) } }, "Fixture"),
      /invalid chapter pagination HTML/i,
    );
  });

  it("bounds direct HTML parser inputs behind fixed source-owned failures", () => {
    const oversized = "x".repeat(2 * 1_024 * 1_024 + 1);
    assert.throws(
      () => parseArchiveCatalogPage(oversized, 1, `${DOMAIN}/comic/page/2/`),
      /^Error: Rinko Comics returned invalid catalog HTML\.$/,
    );
    assert.throws(
      () => parseSeriesDocument(oversized, MANGA_ID),
      /^Error: Rinko Comics returned invalid series HTML\.$/,
    );
    assert.throws(
      () => parseChapterDetails(oversized, CHAPTER_ID, MANGA_ID, 12, SITE_TITLE),
      /^Error: Rinko Comics returned invalid reader HTML\.$/,
    );
    assert.throws(
      () => parseSeriesDocument(7 as unknown as string, MANGA_ID),
      /^Error: Rinko Comics returned invalid series HTML\.$/,
    );
  });

  it("accepts strict real dates and never fabricates malformed dates", () => {
    assert.equal(parseRinkoDate("Jul 30, 2026")?.toISOString(), "2026-07-30T00:00:00.000Z");
    assert.equal(parseRinkoDate("February 29, 2024")?.toISOString(), "2024-02-29T00:00:00.000Z");
    assert.equal(parseRinkoDate("February 29, 2025"), undefined);
    assert.equal(parseRinkoDate("2026-07-30"), undefined);
    assert.equal(parseRinkoDate("Jul 30, 2026 garbage"), undefined);
    assert.equal(parseRinkoDate("Januarx 30, 2026"), undefined);
  });
});

describe("Rinko Comics reader parser", () => {
  it("requires the public marker, exact identity and ordered allowlisted images", () => {
    const details = parseChapterDetails(READER_HTML, CHAPTER_ID, MANGA_ID, 12, SITE_TITLE);
    assert.deepEqual(details, {
      id: CHAPTER_ID,
      mangaId: MANGA_ID,
      pages: [
        "https://cdn.rinkocomics.com/wp-content/uploads/comics/fixture-flower-path/12/01.webp",
        "https://cdn.rinkocomics.com/wp-content/uploads/comics/fixture-flower-path/12/02.webp",
      ],
    });
    const duplicateCanonical = READER_HTML.replace(
      "</head>",
      `<link rel="canonical" href="${DOMAIN}/chapter/fixture-flower-path-chapter-12/"></head>`,
    );
    const duplicateDetails = parseChapterDetails(
      duplicateCanonical,
      CHAPTER_ID,
      MANGA_ID,
      12,
      SITE_TITLE,
    );
    if (!("pages" in duplicateDetails)) assert.fail("Expected image pages.");
    assert.equal(duplicateDetails.pages.length, 2);

    const staleNumberDetails = parseChapterDetails(
      READER_HTML,
      CHAPTER_ID,
      MANGA_ID,
      12.5,
      SITE_TITLE,
    );
    if (!("pages" in staleNumberDetails)) assert.fail("Expected image pages.");
    assert.equal(staleNumberDetails.pages.length, 2);
  });

  it("invalidates the whole reader for access, identity, title, count, order, or origin failures", () => {
    assert.throws(
      () =>
        parseChapterDetails(
          READER_HTML.replace("chapter-tag free", "chapter-tag locked"),
          CHAPTER_ID,
          MANGA_ID,
          12,
          SITE_TITLE,
        ),
      /not publicly readable/i,
    );
    assert.throws(
      () =>
        parseChapterDetails(
          READER_HTML,
          CHAPTER_ID,
          MANGA_ID,
          11,
          "Fixture Flower Path Chapter 11",
        ),
      /different chapter title/i,
    );
    assert.throws(
      () => parseChapterDetails(READER_HTML, CHAPTER_ID, MANGA_ID, -0, SITE_TITLE),
      /different chapter number/i,
    );
    assert.throws(
      () =>
        parseChapterDetails(
          READER_HTML.replace("Chapter 12", "Chapter 012"),
          CHAPTER_ID,
          MANGA_ID,
          12,
          SITE_TITLE,
        ),
      /different chapter title/i,
    );
    assert.throws(
      () => parseChapterDetails(READER_HTML, CHAPTER_ID, MANGA_ID, 12, ` ${SITE_TITLE}`),
      /different chapter title/i,
    );
    assert.throws(
      () =>
        parseChapterDetails(
          READER_HTML.replace(
            '<span class="chapter-tag free">Free</span>',
            '<span class="chapter-tag free">Free</span><span class="chapter-tag locked">Locked</span>',
          ),
          CHAPTER_ID,
          MANGA_ID,
          12,
          SITE_TITLE,
        ),
      /not publicly readable/i,
    );
    assert.throws(
      () =>
        parseChapterDetails(
          READER_HTML.replace("chapters/1012", "chapters/9999"),
          CHAPTER_ID,
          MANGA_ID,
          12,
          SITE_TITLE,
        ),
      /different chapter/i,
    );
    assert.throws(
      () =>
        parseChapterDetails(
          READER_HTML.replace(
            "</head>",
            '<link rel="alternate" type="application/json" href="https://rinkocomics.com/wp-json/wp/v2/chapters/1012"></head>',
          ),
          CHAPTER_ID,
          MANGA_ID,
          12,
          SITE_TITLE,
        ),
      /different chapter/i,
    );
    assert.throws(
      () =>
        parseChapterDetails(
          READER_HTML.replace("2 pages", "3 pages"),
          CHAPTER_ID,
          MANGA_ID,
          12,
          SITE_TITLE,
        ),
      /invalid reader page count/i,
    );
    assert.throws(
      () =>
        parseChapterDetails(
          READER_HTML.replace(
            '<img class="chapter-image lazy-image"',
            '<img src="https://evil.example/tracker.gif"><img class="chapter-image lazy-image"',
          ),
          CHAPTER_ID,
          MANGA_ID,
          12,
          SITE_TITLE,
        ),
      /invalid reader page count/i,
    );
    assert.throws(
      () =>
        parseChapterDetails(
          READER_HTML.replace('data-page="2"', 'data-page="1"'),
          CHAPTER_ID,
          MANGA_ID,
          12,
          SITE_TITLE,
        ),
      /invalid chapter image/i,
    );
    assert.throws(
      () =>
        parseChapterDetails(
          READER_HTML.replace("https://cdn.rinkocomics.com", "https://evil.example"),
          CHAPTER_ID,
          MANGA_ID,
          12,
          SITE_TITLE,
        ),
      /invalid chapter image/i,
    );
    for (const unsafePath of ["%30%31.webp", "%25252e%25252e.webp"]) {
      assert.throws(
        () =>
          parseChapterDetails(
            READER_HTML.replace("02.webp", unsafePath),
            CHAPTER_ID,
            MANGA_ID,
            12,
            SITE_TITLE,
          ),
        /invalid chapter image/i,
      );
    }
  });
});
