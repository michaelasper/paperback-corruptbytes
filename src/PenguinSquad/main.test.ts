import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ContentRating, type SourceManga } from "@paperback/types";

import { PenguinClient, type PenguinTransport } from "./client.js";
import { PenguinSquadExtension, SECTIONS } from "./main.js";
import { PenguinAccessError, type PenguinPageMetadata } from "./models.js";
import { encodeChapterId, encodeSeriesId } from "./network.js";
import {
  PENGUIN_SERIES_SLUG,
  PENGUIN_SERIES_TITLE,
  catalogHtml,
  chapterHtml,
  searchHtml,
  seriesHtml,
} from "./test-fixtures.js";

const DOMAIN = "https://penguin-squad.com";
const seriesUrl = `${DOMAIN}/novels/${PENGUIN_SERIES_SLUG}`;
const seriesId = encodeSeriesId(PENGUIN_SERIES_SLUG);
const publicChapterSlug = "chapter-3-synthetic-part-3";
const lockedChapterSlug = "chapter-4-synthetic-part-4";
const publicChapterUrl = `${seriesUrl}/${publicChapterSlug}`;
const lockedChapterUrl = `${seriesUrl}/${lockedChapterSlug}`;

const routes = (overrides: Record<string, string> = {}): Record<string, string> => ({
  [`${DOMAIN}/novels`]: catalogHtml({ count: 60 }),
  [`${DOMAIN}/novels?page=2`]: catalogHtml({ page: 2, count: 60 }),
  [`${DOMAIN}/novels?page=5`]: catalogHtml({ page: 5, count: 5 }),
  [`${DOMAIN}/search?q=dragon`]: searchHtml({ term: "dragon", count: 5 }),
  [seriesUrl]: seriesHtml(),
  [publicChapterUrl]: chapterHtml(),
  [lockedChapterUrl]: chapterHtml({
    chapterSlug: lockedChapterSlug,
    number: 4,
    title: "Synthetic Part 4",
    gate: "auth",
  }),
  ...overrides,
});

const extension = (overrides: Record<string, string> = {}): PenguinSquadExtension => {
  const map = routes(overrides);
  const transport: PenguinTransport = async (url) => {
    const body = map[url];
    if (body === undefined) throw new Error(`Unexpected fixture request: ${url}`);
    return body;
  };
  return new PenguinSquadExtension(new PenguinClient(transport));
};

const catalogSection = { id: SECTIONS.CATALOG, title: "All novels", type: 1 } as never;

describe("Penguin Squad extension discovery and search", () => {
  it("advertises one catalog section and pages through real server pages", async () => {
    const source = extension();
    const sections = await source.getDiscoverSections();
    assert.equal(sections.length, 1);
    assert.equal(sections[0]?.title, "All novels");

    const first = await source.getDiscoverSectionItems(catalogSection, undefined);
    assert.equal(first.items.length, 60);
    assert.deepEqual(first.metadata, { page: 2 });
    const firstItem = first.items[0];
    if (firstItem?.type !== "simpleCarouselItem") throw new Error("unexpected catalog item type.");
    assert.equal(firstItem.title, "Synthetic Series 100");
    assert.equal(firstItem.contentRating, ContentRating.ADULT);

    const second = await source.getDiscoverSectionItems(
      catalogSection,
      first.metadata as PenguinPageMetadata,
    );
    const secondItem = second.items[0];
    if (secondItem?.type !== "simpleCarouselItem") throw new Error("unexpected catalog item type.");
    assert.equal(secondItem.title, "Synthetic Series 200");

    const terminal = await source.getDiscoverSectionItems(catalogSection, { page: 5 });
    assert.equal(terminal.items.length, 5);
    assert.equal(terminal.metadata, undefined);
  });

  it("ignores unknown sections and rejects malformed page metadata", async () => {
    const source = extension();
    assert.deepEqual(await source.getDiscoverSectionItems({ id: "other" } as never, undefined), {
      items: [],
    });
    await assert.rejects(
      source.getDiscoverSectionItems(catalogSection, { page: 0 } as PenguinPageMetadata),
      /page number is invalid/,
    );
    await assert.rejects(
      source.getDiscoverSectionItems(catalogSection, {
        page: 2,
        query: "x",
      } as PenguinPageMetadata),
      /search continuation/,
    );
  });

  it("searches by title and returns the advertised catalog for an empty query", async () => {
    const source = extension();
    const results = await source.getSearchResults({ title: "  dragon " }, undefined, undefined);
    assert.equal(results.items.length, 5);
    assert.equal(results.items[0]?.mangaId, "synthetic-series-200");
    assert.equal(results.items[0]?.subtitle, "Fantasy");
    assert.equal(results.items[0]?.contentRating, ContentRating.ADULT);
    assert.equal(results.metadata, undefined);

    const browse = await source.getSearchResults({ title: "" }, undefined, undefined);
    assert.equal(browse.items.length, 60);
    assert.deepEqual(browse.metadata, { page: 2 });
    await assert.rejects(
      source.getSearchResults({ title: "dragon" }, { query: "wolf" } as PenguinPageMetadata),
      /search continuation/,
    );
  });

  for (const suffix of ["", `/${publicChapterSlug}`]) {
    it(`resolves a pasted URL longer than 100 characters with suffix '${suffix}' to the exact parent series`, async () => {
      const slug = `${"long-novel-".repeat(9)}title`;
      const parentUrl = `${DOMAIN}/novels/${slug}`;
      const title = `${parentUrl}${suffix}`;
      assert.ok(title.length > 100);
      const requests: string[] = [];
      const transport: PenguinTransport = async (url) => {
        requests.push(url);
        assert.equal(url, parentUrl);
        return seriesHtml({ slug });
      };
      const source = new PenguinSquadExtension(new PenguinClient(transport));
      const results = await source.getSearchResults({ title }, undefined);
      assert.deepEqual(requests, [parentUrl]);
      assert.equal(results.items.length, 1);
      assert.equal(results.items[0]?.mangaId, encodeSeriesId(slug));
    });
  }

  it("still normalizes and clamps ordinary keywords to 100 characters", async () => {
    const term = "a".repeat(100);
    const requests: string[] = [];
    const transport: PenguinTransport = async (url) => {
      requests.push(url);
      return searchHtml({ term, count: 5 });
    };
    const source = new PenguinSquadExtension(new PenguinClient(transport));
    const results = await source.getSearchResults({ title: `  ${"a".repeat(140)}  ` }, undefined);
    assert.deepEqual(requests, [`${DOMAIN}/search?q=${term}`]);
    assert.equal(results.items.length, 5);
  });

  it("rejects invalid search input before requesting a page", async () => {
    const transport: PenguinTransport = async () => {
      assert.fail("invalid input must not issue a request");
    };
    const source = new PenguinSquadExtension(new PenguinClient(transport));
    for (const title of [42, `https://penguin-squad.com/novels/${"a".repeat(100)}\u0000`]) {
      await assert.rejects(
        source.getSearchResults({ title } as never, undefined),
        /search term is invalid/,
      );
    }
  });

  it("resolves a pasted chapter URL to its series", async () => {
    const source = extension();
    const results = await source.getSearchResults(
      { title: publicChapterUrl },
      undefined,
      undefined,
    );
    assert.equal(results.items.length, 1);
    assert.equal(results.items[0]?.mangaId, seriesId);
    assert.equal(results.items[0]?.title, PENGUIN_SERIES_TITLE);
    assert.match(
      results.items[0]?.imageUrl ?? "",
      /^https:\/\/qdqgxwrdzpxpkvamufqp\.supabase\.co\//,
    );
  });
});

describe("Penguin Squad extension series", () => {
  it("maps the series metadata to a novel entry", async () => {
    const source = extension();
    const manga = await source.getMangaDetails(seriesId);
    assert.equal(manga.mangaId, seriesId);
    assert.equal(manga.mangaInfo.primaryTitle, PENGUIN_SERIES_TITLE);
    assert.deepEqual(manga.mangaInfo.secondaryTitles, ["합성 원제"]);
    assert.equal(manga.mangaInfo.contentType, "novel");
    assert.equal(manga.mangaInfo.contentRating, ContentRating.EVERYONE);
    assert.equal(manga.mangaInfo.status, "Ongoing");
    assert.equal(manga.mangaInfo.author, "Synthetic Author");
    assert.equal(manga.mangaInfo.synopsis, "Synthetic synopsis for parser coverage.");
    assert.equal(manga.mangaInfo.shareUrl, seriesUrl);
    assert.equal(manga.mangaInfo.additionalInfo?.["translator"], "Synthetic Translator");
    assert.deepEqual(
      manga.mangaInfo.tagGroups?.[0]?.tags.map((tag) => tag.title),
      ["Fantasy", "Romance"],
    );
  });

  it("marks an adult series and rejects an unknown series ID", async () => {
    const source = extension({ [seriesUrl]: seriesHtml({ adult: true }) });
    const manga = await source.getMangaDetails(seriesId);
    assert.equal(manga.mangaInfo.contentRating, ContentRating.ADULT);
    await assert.rejects(source.getMangaDetails("../escape"), /series ID is invalid/);
  });

  it("lists the complete history and labels unreadable chapters", async () => {
    const source = extension();
    const manga = await source.getMangaDetails(seriesId);
    const chapters = await source.getChapters(manga);
    assert.deepEqual(
      chapters.map((chapter) => chapter.chapNum),
      [4, 3, 2, 1],
    );
    assert.deepEqual(
      chapters.map((chapter) => chapter.sortingIndex),
      [0, 1, 2, 3],
    );
    assert.equal(chapters[0]?.title, "🔒 Premium • Synthetic Part 4");
    assert.equal(chapters[1]?.title, "Synthetic Part 3");
    assert.equal(chapters[1]?.chapterId, encodeChapterId(PENGUIN_SERIES_SLUG, publicChapterSlug));
    assert.equal(chapters[1]?.publishDate?.toISOString(), "2026-01-03T00:00:00.000Z");
    assert.equal(chapters[0]?.additionalInfo?.["access"], "locked");
    assert.equal(chapters[1]?.additionalInfo?.["url"], publicChapterUrl);
    assert.equal(chapters[1]?.sourceManga, manga);
  });

  it("filters dated chapters but keeps undated ones", async () => {
    const source = extension();
    const manga = await source.getMangaDetails(seriesId);
    const chapters = await source.getChapters(manga, new Date("2026-01-02T12:00:00.000Z"));
    assert.deepEqual(
      chapters.map((chapter) => chapter.chapNum),
      [4, 3],
    );
  });

  it("rejects a source manga without a valid penguin ID", async () => {
    const source = extension();
    await assert.rejects(
      source.getChapters({ mangaId: "not a slug", mangaInfo: {} } as SourceManga),
      /source manga is invalid/,
    );
  });
});

describe("Penguin Squad extension reader", () => {
  it("serves a public chapter as sanitized novel HTML", async () => {
    const source = extension();
    const manga = await source.getMangaDetails(seriesId);
    const chapters = await source.getChapters(manga);
    const publicChapter = chapters.find((chapter) => chapter.chapNum === 3);
    assert.ok(publicChapter);
    const details = await source.getChapterDetails(publicChapter);
    assert.equal(details.type, "html");
    assert.equal(details.id, publicChapter.chapterId);
    assert.equal(details.mangaId, seriesId);
    assert.ok("html" in details);
    assert.match(details.html, /Synthetic paragraph 1\./);
    assert.doesNotMatch(details.html, /class=/);
  });

  it("refuses a premium chapter without requesting its page", async () => {
    const source = extension({ [lockedChapterUrl]: "unexpected" });
    const manga = await source.getMangaDetails(seriesId);
    const chapters = await source.getChapters(manga);
    const lockedChapter = chapters.find((chapter) => chapter.chapNum === 4);
    assert.ok(lockedChapter);
    await assert.rejects(
      source.getChapterDetails(lockedChapter),
      (error: unknown) => error instanceof PenguinAccessError && error.reason === "locked",
    );
  });

  it("refuses a chapter ID that does not belong to the given series", async () => {
    const source = extension();
    const manga = await source.getMangaDetails(seriesId);
    await assert.rejects(
      source.getChapterDetails({
        chapterId: encodeChapterId("other-novel", publicChapterSlug),
        sourceManga: manga,
        langCode: "en",
        chapNum: 3,
      }),
      /does not belong to this series/,
    );
    await assert.rejects(
      source.getChapterDetails({
        chapterId: "not-a-chapter-id",
        sourceManga: manga,
        langCode: "en",
        chapNum: 3,
      }),
      /chapter ID is invalid/,
    );
  });

  it("refuses a reader page that still carries an access gate", async () => {
    const source = extension({
      [publicChapterUrl]: chapterHtml({ gate: "heading" }),
    });
    const manga = await source.getMangaDetails(seriesId);
    const chapters = await source.getChapters(manga);
    const publicChapter = chapters.find((chapter) => chapter.chapNum === 3);
    assert.ok(publicChapter);
    await assert.rejects(
      source.getChapterDetails(publicChapter),
      (error: unknown) => error instanceof PenguinAccessError && error.reason === "locked",
    );
  });
});
