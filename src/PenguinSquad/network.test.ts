import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PenguinAccessError } from "./models.js";
import {
  buildCatalogUrl,
  buildChapterUrl,
  buildSearchUrl,
  buildSeriesUrl,
  decodeChapterId,
  decodeSeriesId,
  encodeChapterId,
  encodeSeriesId,
  isChapterSlug,
  normalizeSearchTerm,
  parseChapterUrl,
  parseContinuation,
  parsePageMetadata,
  parsePastedUrl,
  parseSeriesUrl,
} from "./network.js";
import { PENGUIN_SERIES_SLUG } from "./test-fixtures.js";

const CHAPTER_SLUG = "chapter-281-linne-s-dream";

describe("Penguin Squad identifiers", () => {
  it("round-trips the exact series and chapter slugs", () => {
    const seriesId = encodeSeriesId(PENGUIN_SERIES_SLUG);
    assert.equal(decodeSeriesId(seriesId), PENGUIN_SERIES_SLUG);
    const chapterId = encodeChapterId(PENGUIN_SERIES_SLUG, CHAPTER_SLUG);
    assert.equal(chapterId, "synthetic-novel%2Fchapter-281-linne-s-dream");
    assert.deepEqual(decodeChapterId(chapterId), { seriesId, chapterId });
    assert.equal(
      buildChapterUrl(chapterId).endsWith(`/${PENGUIN_SERIES_SLUG}/${CHAPTER_SLUG}`),
      true,
    );
  });

  it("rejects identifiers that could change the request route", () => {
    for (const value of [
      "",
      "Synthetic-Novel",
      "../etc/passwd",
      "synthetic/novel",
      "synthetic%2Fnovel",
      "synthetic novel",
      "synthetic-novel\n",
      "synthetic-novel?x=1",
    ]) {
      assert.throws(() => decodeSeriesId(value), /series ID is invalid/);
    }
    for (const value of [
      "synthetic-novel",
      "synthetic-novel%2F",
      "synthetic-novel%2Fchapter-281-linne%2Fs-dream",
      "synthetic%2Fnovel%2Fchapter-281-linne-s-dream",
      "synthetic-novel%2Fchapter-281-linne-s-dream%2F..",
    ]) {
      assert.throws(() => decodeChapterId(value), /chapter ID is invalid/);
    }
    assert.equal(isChapterSlug("chapter-1-a"), true);
    assert.equal(isChapterSlug("chapter-1"), true);
    assert.equal(isChapterSlug("chapter--a"), false);
    assert.equal(isChapterSlug("prologue"), false);
  });
});

describe("Penguin Squad routes", () => {
  it("builds only the published browse, search, series, and chapter routes", () => {
    assert.equal(buildCatalogUrl(1), "https://penguin-squad.com/novels");
    assert.equal(buildCatalogUrl(5), "https://penguin-squad.com/novels?page=5");
    assert.equal(
      buildSearchUrl("dragon knight"),
      "https://penguin-squad.com/search?q=dragon%20knight",
    );
    assert.equal(buildSearchUrl("   "), "https://penguin-squad.com/search");
    assert.equal(
      buildSeriesUrl(encodeSeriesId(PENGUIN_SERIES_SLUG)),
      "https://penguin-squad.com/novels/synthetic-novel",
    );
    assert.throws(() => parsePageMetadata({ page: 0 }), /page number is invalid/);
    assert.throws(() => parsePageMetadata({ page: 501 }), /too large/);
    assert.deepEqual(parsePageMetadata(undefined), { page: 1 });
    assert.deepEqual(parsePageMetadata({ page: 3 }), { page: 3 });
    assert.throws(() => parsePageMetadata({ page: 2, extra: true }), /page metadata is invalid/);
  });

  it("binds a continuation to the query that produced it", () => {
    assert.equal(parseContinuation("/novels?page=2", { page: 1 }), 2);
    assert.equal(parseContinuation("/search?page=2&q=dragon", { page: 1, term: "dragon" }), 2);
    assert.throws(() => parseContinuation("/novels?page=3", { page: 1 }), /did not advance/);
    assert.throws(
      () => parseContinuation("/novels?page=2", { page: 1, term: "dragon" }),
      /trusted/,
    );
    assert.throws(
      () => parseContinuation("/search?page=2&q=wolf", { page: 1, term: "dragon" }),
      /preserve the search term/,
    );
    assert.throws(
      () => parseContinuation("https://example.invalid/novels?page=2", { page: 1 }),
      /trusted/,
    );
    assert.throws(() => parseContinuation("/novels?page=2&sort=new", { page: 1 }), /trusted/);
  });

  it("resolves pasted series and chapter URLs to a series", () => {
    const series = "https://penguin-squad.com/novels/synthetic-novel";
    assert.equal(parseSeriesUrl(series), encodeSeriesId(PENGUIN_SERIES_SLUG));
    assert.equal(parsePastedUrl(series), encodeSeriesId(PENGUIN_SERIES_SLUG));
    assert.equal(parsePastedUrl(`${series}/${CHAPTER_SLUG}`), encodeSeriesId(PENGUIN_SERIES_SLUG));
    assert.deepEqual(parseChapterUrl(`${series}/${CHAPTER_SLUG}`), {
      seriesId: encodeSeriesId(PENGUIN_SERIES_SLUG),
      chapterId: encodeChapterId(PENGUIN_SERIES_SLUG, CHAPTER_SLUG),
    });
    for (const value of [
      "http://penguin-squad.com/novels/synthetic-novel",
      "https://example.invalid/novels/synthetic-novel",
      "https://penguin-squad.com/series/synthetic-novel",
      "https://penguin-squad.com/novels/synthetic-novel/",
      "https://penguin-squad.com/novels/synthetic-novel?page=2",
      "https://penguin-squad.com/novels/synthetic-novel/extra/segment",
      "https://user:pass@penguin-squad.com/novels/synthetic-novel",
      "https://penguin-squad.com:8443/novels/synthetic-novel",
    ]) {
      assert.equal(parsePastedUrl(value), undefined, value);
    }
  });

  it("clamps search terms to the site field limit", () => {
    assert.equal(normalizeSearchTerm("  dragon   knight  "), "dragon knight");
    assert.equal(normalizeSearchTerm("a".repeat(140)).length, 100);
    assert.throws(() => normalizeSearchTerm("bad\u0000term"), /search term is invalid/);
  });
});

describe("Penguin Squad access errors", () => {
  it("names the refusal reason", () => {
    assert.equal(new PenguinAccessError("locked").reason, "locked");
    assert.equal(new PenguinAccessError("locked").name, "PenguinAccessError");
    assert.equal(new PenguinAccessError("unknown").reason, "unknown");
  });
});
