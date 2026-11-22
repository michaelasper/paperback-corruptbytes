import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PenguinAccessError } from "./models.js";
import { encodeChapterId, encodeSeriesId, decodeChapterId } from "./network.js";
import { parseCatalogPage, parseReader, parseSeries } from "./parsers.js";
import {
  PENGUIN_SERIES_SLUG,
  catalogHtml,
  chapterHtml,
  fixtureChapters,
  fixtureParagraphs,
  searchHtml,
  seriesHtml,
} from "./test-fixtures.js";

const seriesId = encodeSeriesId(PENGUIN_SERIES_SLUG);
const publicChapterId = encodeChapterId(PENGUIN_SERIES_SLUG, "chapter-3-synthetic-part-3");

const readerFixture = (options: Parameters<typeof chapterHtml>[0] = {}) =>
  parseReader(chapterHtml(options), { seriesId, chapterId: publicChapterId }, { number: 3 });

describe("Penguin Squad catalog pages", () => {
  it("returns one server page of cards with its continuation", () => {
    const page = parseCatalogPage(catalogHtml(), { kind: "browse", page: 1 });
    assert.equal(page.items.length, 60);
    assert.equal(page.next, 2);
    const first = page.items[0];
    assert.equal(first?.title, "Synthetic Series 100");
    assert.equal(first?.adult, true);
    assert.match(first?.coverUrl ?? "", /^https:\/\/qdqgxwrdzpxpkvamufqp\.supabase\.co\//);
    assert.equal(first?.genre, "Fantasy");
  });

  it("keeps recommendation rails out of the catalog", () => {
    const page = parseCatalogPage(catalogHtml({ count: 60, recommendations: 4 }), {
      kind: "browse",
      page: 1,
    });
    assert.equal(page.items.length, 60);
    assert.equal(
      page.items.some((item) => item.title.includes("Synthetic Series 90")),
      false,
    );
  });

  it("stops at the terminal page and accepts a recognised empty page", () => {
    const terminal = parseCatalogPage(catalogHtml({ page: 5, count: 5 }), {
      kind: "browse",
      page: 5,
    });
    assert.equal(terminal.items.length, 5);
    assert.equal(terminal.next, undefined);

    const empty = parseCatalogPage(catalogHtml({ page: 6, count: 0, emptyState: true }), {
      kind: "browse",
      page: 6,
    });
    assert.deepEqual(empty, { items: [] });
    assert.throws(
      () =>
        parseCatalogPage("<html><body><h1>All Novels</h1></body></html>", {
          kind: "browse",
          page: 1,
        }),
      /returned no catalog cards/,
    );
  });

  it("drops covers that leave the approved media host", () => {
    const html = catalogHtml({ count: 1 }).replace(
      /https:\/\/qdqgxwrdzpxpkvamufqp\.supabase\.co\/[^"]+/,
      "https://unknown-cdn.invalid/cover.webp",
    );
    const page = parseCatalogPage(html, { kind: "browse", page: 1 });
    assert.equal(page.items[0]?.coverUrl, undefined);
  });

  it("rejects a forged or jumping continuation", () => {
    const forged = catalogHtml({ count: 1 }).replace(
      'href="/novels?page=2"',
      'href="https://penguin-squad.com/novels?page=4"',
    );
    assert.throws(() => parseCatalogPage(forged, { kind: "browse", page: 1 }), /did not advance/);
    const foreign = catalogHtml({ count: 1 }).replace(
      'href="/novels?page=2"',
      'href="https://example.invalid/novels?page=2"',
    );
    assert.throws(() => parseCatalogPage(foreign, { kind: "browse", page: 1 }), /was not trusted/);
  });

  it("does not trust a page whose heading is not the catalog", () => {
    const html = catalogHtml({ count: 1 }).replace("<h1>All Novels</h1>", "<h1>Sign in</h1>");
    assert.throws(() => parseCatalogPage(html, { kind: "browse", page: 1 }), /novel catalog/);
  });
});

describe("Penguin Squad search pages", () => {
  it("returns only real results and honours the term the server echoed", () => {
    const page = parseCatalogPage(searchHtml({ term: "dragon", count: 5, recommendations: 3 }), {
      kind: "search",
      term: "dragon",
      page: 1,
    });
    assert.equal(page.items.length, 5);
    assert.equal(page.next, undefined);
    assert.equal(
      page.items.some((item) => item.title.includes("Synthetic Series 9")),
      false,
    );
  });

  it("accepts a zero-result page and keeps the continuation query-bound", () => {
    const empty = parseCatalogPage(
      searchHtml({ term: "zzz", count: 0, emptyState: true, recommendations: 4 }),
      { kind: "search", term: "zzz", page: 1 },
    );
    assert.deepEqual(empty, { items: [] });

    const paged = parseCatalogPage(searchHtml({ term: "dragon", count: 5, nextPage: 2 }), {
      kind: "search",
      term: "dragon",
      page: 1,
    });
    assert.equal(paged.next, 2);
    assert.throws(
      () =>
        parseCatalogPage(searchHtml({ term: "dragon", count: 5, nextPage: 2 }), {
          kind: "search",
          term: "wolf",
          page: 1,
        }),
      /requested search page/,
    );
  });
});

describe("Penguin Squad series records", () => {
  it("derives the complete ordered chapter history from structured records", () => {
    const series = parseSeries(seriesHtml(), seriesId);
    assert.equal(series.title, "Synthetic Novel");
    assert.equal(series.synopsis, "Synthetic synopsis for parser coverage.");
    assert.deepEqual(series.authors, ["Synthetic Author"]);
    assert.equal(series.translator, "Synthetic Translator");
    assert.equal(series.originalTitle, "합성 원제");
    assert.deepEqual(series.tags, ["Fantasy", "Romance"]);
    assert.equal(series.status, "Ongoing");
    assert.equal(series.adult, false);
    assert.match(series.coverUrl ?? "", /^https:\/\/qdqgxwrdzpxpkvamufqp\.supabase\.co\//);
    assert.deepEqual(
      series.chapters.map((chapter) => chapter.number),
      [4, 3, 2, 1],
    );
    assert.deepEqual(
      series.chapters.map((chapter) => chapter.access.kind),
      ["locked", "public", "public", "public"],
    );
    const first = series.chapters[3];
    assert.equal(
      first?.chapterId,
      encodeChapterId(PENGUIN_SERIES_SLUG, "chapter-1-synthetic-part-1"),
    );
    assert.equal(first?.title, "Synthetic Part 1");
    assert.equal(first?.publishedAt?.toISOString(), "2026-01-01T00:00:00.000Z");
  });

  it("collapses the duplicate record array the site streams", () => {
    assert.equal(parseSeries(seriesHtml({ duplicateArrays: true }), seriesId).chapters.length, 4);
    assert.equal(parseSeries(seriesHtml({ duplicateArrays: false }), seriesId).chapters.length, 4);
  });

  it("rejects conflicting records, counts, and chapter links", () => {
    const chapters = fixtureChapters();
    const conflicting = chapters.map((chapter, index) =>
      index === 0 ? { ...chapter, premium: true } : chapter,
    );
    assert.throws(
      () => parseSeries(seriesHtml({ chapters, secondArray: conflicting }), seriesId),
      /conflicting chapter records/,
    );
    assert.throws(
      () => parseSeries(seriesHtml({ premiumCount: 2 }), seriesId),
      /inconsistent chapter counts/,
    );
    assert.throws(
      () => parseSeries(seriesHtml({ includeLinks: false }), seriesId),
      /chapter links/,
    );
  });

  it("rejects incomplete records instead of guessing access", () => {
    const broken = [{ ...fixtureChapters()[0]!, number: -1 }];
    assert.throws(
      () => parseSeries(seriesHtml({ chapters: broken }), seriesId),
      /incomplete chapter record/,
    );
    assert.throws(
      () => parseSeries(seriesHtml({ chapters: [] }), seriesId),
      /structured chapter records/,
    );
  });

  it("refuses a page that identifies a different series", () => {
    const other = "https://penguin-squad.com/novels/other-novel";
    assert.throws(
      () => parseSeries(seriesHtml({ canonical: other }), seriesId),
      /different series/,
    );
    assert.throws(() => parseSeries(seriesHtml({ bookUrl: other }), seriesId), /different series/);
    assert.throws(
      () => parseSeries("<html><body><h1>Nothing</h1></body></html>", seriesId),
      /did not identify/,
    );
  });

  it("keeps the 18+ badge scoped to the series header", () => {
    assert.equal(parseSeries(seriesHtml({ adult: true }), seriesId).adult, true);
    const html = seriesHtml().replace(
      "</body>",
      `<section><a href="/novels/synthetic-series-1"><h3>Other</h3><span aria-label="Adult content">18+</span></a></section></body>`,
    );
    assert.equal(parseSeries(html, seriesId).adult, false);
  });
});

describe("Penguin Squad reader", () => {
  it("returns sanitized XHTML that keeps the published attribution", () => {
    const reader = readerFixture();
    assert.equal(reader.chapterId, publicChapterId);
    assert.equal(reader.seriesId, seriesId);
    assert.match(reader.html, /^<html xmlns="http:\/\/www\.w3\.org\/1999\/xhtml">/);
    assert.match(reader.html, /Synthetic paragraph 1\./);
    assert.match(reader.html, /Synthetic rights notice\./);
    assert.doesNotMatch(reader.html, /class=/);
  });

  it("strips active markup and unapproved images", () => {
    const reader = readerFixture({
      paragraphs: ["<script>steal()</script>Safe text.<img src=x onerror=steal()>"],
      images: [
        "https://unknown-cdn.invalid/scan.webp",
        "https://qdqgxwrdzpxpkvamufqp.supabase.co/storage/v1/object/public/covers/scan.webp",
      ],
    });
    assert.doesNotMatch(reader.html, /<script/i);
    assert.doesNotMatch(reader.html, /onerror/i);
    assert.doesNotMatch(reader.html, /unknown-cdn\.invalid/);
    assert.match(
      reader.html,
      /https:\/\/qdqgxwrdzpxpkvamufqp\.supabase\.co\/storage\/v1\/object\/public\/covers\/scan\.webp/,
    );
    assert.match(reader.html, /Safe text\./);
  });

  it("refuses every published access gate even when preview text exists", () => {
    for (const gate of ["auth", "auth-query", "heading", "overlay"] as const) {
      assert.throws(
        () => readerFixture({ gate }),
        (error: unknown) => error instanceof PenguinAccessError && error.reason === "locked",
        gate,
      );
    }
  });

  it("does not treat chapter prose as an access gate", () => {
    const reader = readerFixture({
      paragraphs: ["A character discusses premium chapters and unlock this chapter."],
    });
    assert.match(reader.html, /premium chapters/);
  });

  it("refuses content that does not identify the requested chapter", () => {
    assert.throws(() => readerFixture({ position: 4 }), /different chapter/);
    assert.throws(
      () =>
        readerFixture({
          canonical: `https://penguin-squad.com/novels/${PENGUIN_SERIES_SLUG}/chapter-4-other`,
        }),
      /different chapter/,
    );
    assert.throws(
      () => readerFixture({ partOf: "https://penguin-squad.com/novels/other-novel" }),
      /different chapter/,
    );
  });

  it("refuses missing, ambiguous, or empty readers", () => {
    assert.throws(() => readerFixture({ readerCount: 0 }), /did not return readable/);
    assert.throws(() => readerFixture({ readerCount: 2 }), /ambiguous/);
    assert.throws(() => readerFixture({ paragraphs: [], notice: false }), /content was empty/);
    assert.throws(
      () =>
        readerFixture({
          paragraphs: [],
          notice: false,
          images: ["https://unknown-cdn.invalid/page.webp"],
        }),
      /content was empty/,
    );
  });

  it("serves an illustration-only chapter from an approved media host", () => {
    const reader = readerFixture({
      paragraphs: [],
      notice: false,
      images: [
        "https://qdqgxwrdzpxpkvamufqp.supabase.co/storage/v1/object/public/covers/page.webp",
      ],
    });
    assert.match(reader.html, /<img src="https:\/\/qdqgxwrdzpxpkvamufqp\.supabase\.co\//);
  });

  it("rejects a chapter ID that names another series", () => {
    const foreign = encodeChapterId("other-novel", "chapter-3-synthetic-part-3");
    assert.throws(
      () => parseReader(chapterHtml(), { seriesId, chapterId: foreign }, { number: 3 }),
      /different chapter/,
    );
    assert.equal(decodeChapterId(foreign).seriesId, encodeSeriesId("other-novel"));
  });
});

describe("Penguin Squad reader fixture paragraphs", () => {
  it("keeps synthetic paragraphs distinct", () => {
    const paragraphs = fixtureParagraphs(4);
    assert.equal(paragraphs.length, 4);
    assert.equal(new Set(paragraphs).size, 4);
  });
});
