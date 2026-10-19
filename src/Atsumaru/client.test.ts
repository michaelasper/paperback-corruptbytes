import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { ContentRating, type Chapter, type Request, type SourceManga } from "@paperback/types";

import { SourceHttpError } from "../shared/http.js";
import {
  AtsumaruClient,
  AVAILABLE_FILTERS_MAX_BYTES,
  CANONICAL_MANGA_ID_KEY,
  type AtsumaruTransport,
} from "./client.js";
import type { AtsumaruFetchBodyOptions } from "./network.js";
import {
  AVAILABLE_FILTERS_URL,
  buildAllChaptersUrl,
  buildChapterUrl,
  buildHomeUrl,
  buildMangaRatingUrl,
  buildMangaPageUrl,
  buildNovelChapterUrl,
  buildSearchUrl,
} from "./network.js";
import {
  ratingResponse,
  AVAILABLE_FILTERS_RESPONSE,
  CHAPTERS_RESPONSE,
  COMIC_CHAPTER_RESPONSE,
  MANGA_PAGE_RESPONSE,
  NOVEL_CHAPTER_RESPONSE,
} from "./test-fixtures.js";

class FakeTransport implements AtsumaruTransport {
  readonly calls: string[] = [];
  readonly options: (AtsumaruFetchBodyOptions | undefined)[] = [];
  readonly bodies = new Map<string, unknown>();

  async fetchText(request: Request, options?: AtsumaruFetchBodyOptions): Promise<string> {
    this.calls.push(request.url);
    this.options.push(options);
    const value = this.bodies.get(request.url);
    if (value instanceof Error) throw value;
    if (value === undefined) throw new Error(`Missing fake response for ${request.url}`);
    await Promise.resolve();
    return JSON.stringify(value);
  }
}

const originalApplication = globalThis.Application;
afterEach(() => Object.assign(globalThis, { Application: originalApplication }));

const manga = (mangaId: string, contentType: "comic" | "novel" = "comic"): SourceManga => ({
  mangaId,
  mangaInfo: {
    primaryTitle: "Archive title",
    secondaryTitles: [],
    thumbnailUrl: "https://cdn.atsu.moe/static/posters/archive.webp",
    synopsis: "",
    contentRating: ContentRating.EVERYONE,
    contentType,
    additionalInfo: { [CANONICAL_MANGA_ID_KEY]: mangaId },
  },
});

const setDetailResponses = (
  transport: FakeTransport,
  mangaId = "oJQ4o",
  page: unknown = MANGA_PAGE_RESPONSE,
  rating: unknown = { id: mangaId, isAdult: false, mbContentRating: "Safe" },
): void => {
  transport.bodies.set(buildMangaPageUrl(mangaId), page);
  transport.bodies.set(buildMangaRatingUrl(mangaId), ratingResponse(rating));
};

describe("Atsumaru client cache and identity boundaries", () => {
  it("coalesces detail requests, caches raw JSON, and returns fresh mapped objects", async () => {
    const transport = new FakeTransport();
    setDetailResponses(transport);
    const client = new AtsumaruClient(transport);

    const results = await Promise.all(
      Array.from({ length: 20 }, () => client.getMangaDetails("oJQ4o")),
    );
    assert.equal(transport.calls.filter((url) => url === buildMangaPageUrl("oJQ4o")).length, 1);
    assert.equal(transport.calls.filter((url) => url === buildMangaRatingUrl("oJQ4o")).length, 1);
    assert.ok(results.every((result) => result.mangaId === "oJQ4o"));
    assert.equal(results[0]?.mangaInfo.contentRating, ContentRating.EVERYONE);

    results[0]!.mangaInfo.primaryTitle = "mutated";
    const fresh = await client.getMangaDetails("oJQ4o");
    assert.equal(fresh.mangaInfo.primaryTitle, "Archive Hero");
    assert.equal(transport.calls.length, 2);
  });

  it("does not cache malformed detail responses", async () => {
    const transport = new FakeTransport();
    const url = buildMangaPageUrl("oJQ4o");
    transport.bodies.set(url, { mangaPage: null });
    transport.bodies.set(
      buildMangaRatingUrl("oJQ4o"),
      ratingResponse({
        id: "oJQ4o",
        isAdult: false,
        mbContentRating: "Safe",
      }),
    );
    const client = new AtsumaruClient(transport);

    await assert.rejects(client.getMangaDetails("oJQ4o"), /null or invalid mangaPage/);

    transport.bodies.set(url, MANGA_PAGE_RESPONSE);
    const details = await client.getMangaDetails("oJQ4o");
    assert.equal(details.mangaInfo.primaryTitle, "Archive Hero");
    assert.equal(transport.calls.filter((requestUrl) => requestUrl === url).length, 2);
  });

  it("does not cache malformed filter responses", async () => {
    const transport = new FakeTransport();
    transport.bodies.set(AVAILABLE_FILTERS_URL, { genres: [], statuses: [], types: [] });
    const client = new AtsumaruClient(transport);

    await assert.rejects(client.getFilterOptions(), /invalid tags list/);

    transport.bodies.set(AVAILABLE_FILTERS_URL, AVAILABLE_FILTERS_RESPONSE);
    const filters = await client.getFilterOptions();
    assert.equal(filters.genres.length, 2);
    assert.equal(
      transport.calls.filter((requestUrl) => requestUrl === AVAILABLE_FILTERS_URL).length,
      2,
    );
  });

  it("passes the strict available-filters body cap by default", async () => {
    const transport = new FakeTransport();
    transport.bodies.set(AVAILABLE_FILTERS_URL, AVAILABLE_FILTERS_RESPONSE);

    await new AtsumaruClient(transport).getFilterOptions();

    assert.deepEqual(transport.options[0], { maxBytes: AVAILABLE_FILTERS_MAX_BYTES });
  });

  it("returns but does not retain an oversized parsed taxonomy", async () => {
    const transport = new FakeTransport();
    const largeFilters = {
      genres: [],
      statuses: [],
      types: [],
      tags: Array.from({ length: 20_000 }, (_, index) => ({
        id: `t${index.toString(36)}`,
        name: "n",
      })),
    };
    const encoded = JSON.stringify(largeFilters);
    assert.ok(new TextEncoder().encode(encoded).byteLength < AVAILABLE_FILTERS_MAX_BYTES);
    transport.bodies.set(AVAILABLE_FILTERS_URL, largeFilters);
    const client = new AtsumaruClient(transport);

    const first = await client.getFilterOptions();
    assert.equal(first.tags.length, 20_000);

    transport.bodies.set(AVAILABLE_FILTERS_URL, AVAILABLE_FILTERS_RESPONSE);
    const corrected = await client.getFilterOptions();
    assert.equal(corrected.tags.length, 2);
    assert.equal(
      transport.calls.filter((requestUrl) => requestUrl === AVAILABLE_FILTERS_URL).length,
      2,
    );
  });

  it("parses taxonomy once while returning mutation-isolated filter objects", async () => {
    const transport = new FakeTransport();
    transport.bodies.set(AVAILABLE_FILTERS_URL, AVAILABLE_FILTERS_RESPONSE);
    const client = new AtsumaruClient(transport);

    const first = await client.getFilterOptions();
    first.tags[0]!.name = "mutated";
    const second = await client.getFilterOptions();

    assert.notEqual(second.tags[0]?.name, "mutated");
    assert.equal(
      transport.calls.filter((requestUrl) => requestUrl === AVAILABLE_FILTERS_URL).length,
      1,
    );
  });

  it("uses the complete chapter endpoint and preserves scanlation variants by default", async () => {
    const transport = new FakeTransport();
    setDetailResponses(transport);
    transport.bodies.set(buildAllChaptersUrl("oJQ4o"), CHAPTERS_RESPONSE);
    const client = new AtsumaruClient(transport);
    const sourceManga = await client.getMangaDetails("oJQ4o");

    const chapters = await client.getChapters(sourceManga, undefined, true);
    assert.deepEqual(
      chapters.map(({ chapterId }) => chapterId),
      ["h4j-gl", "wZieNneB", "_rmrsb"],
    );
    assert.equal(chapters[1]?.version, "Archive Team");
    assert.equal(transport.calls.filter((url) => url.includes("allChapters")).length, 1);

    const oneTranslation = await client.getChapters(sourceManga, undefined, false);
    assert.deepEqual(
      oneTranslation.map(({ chapterId }) => chapterId),
      ["h4j-gl", "_rmrsb"],
    );
  });

  it("does not make authoritative chapters depend on auxiliary manga-page metadata", async () => {
    const transport = new FakeTransport();
    const chaptersUrl = buildAllChaptersUrl("oJQ4o");
    transport.bodies.set(chaptersUrl, CHAPTERS_RESPONSE);
    const client = new AtsumaruClient(transport);

    const chapters = await client.getChapters(manga("oJQ4o"));

    assert.equal(chapters.length, 3);
    assert.ok(chapters.every(({ version }) => version === "Scanlation scan-manga-oJQ4o"));
    assert.deepEqual(transport.calls, [chaptersUrl]);
  });

  it("recovers pre-alpha.3 persisted manga records in a fresh runtime", async () => {
    const detailTransport = new FakeTransport();
    setDetailResponses(detailTransport);
    const oldSourceManga = await new AtsumaruClient(detailTransport).getMangaDetails("oJQ4o");
    delete oldSourceManga.mangaInfo.additionalInfo?.atsumaruScanlators;
    delete oldSourceManga.mangaInfo.additionalInfo?.[CANONICAL_MANGA_ID_KEY];
    const persistedSourceManga = JSON.parse(JSON.stringify(oldSourceManga)) as SourceManga;

    const chapterTransport = new FakeTransport();
    chapterTransport.bodies.set(
      buildSearchUrl({ title: "Archive Hero", metadata: { adult: "all" } }, undefined, 1),
      {
        found: 1,
        page: 1,
        hits: [{ document: { id: "oJQ4o", title: "Archive Hero", isAdult: false } }],
      },
    );
    const chaptersUrl = buildAllChaptersUrl("oJQ4o");
    chapterTransport.bodies.set(chaptersUrl, CHAPTERS_RESPONSE);

    const chapters = await new AtsumaruClient(chapterTransport).getChapters(persistedSourceManga);

    assert.notEqual(chapters[0]?.sourceManga, persistedSourceManga);
    assert.notEqual(chapters[0]?.sourceManga.mangaInfo, persistedSourceManga.mangaInfo);
    assert.deepEqual(chapters[0]?.sourceManga, persistedSourceManga);
    assert.ok(chapters.every(({ version }) => version === "Scanlation scan-manga-oJQ4o"));
    assert.deepEqual(chapterTransport.calls, [
      buildSearchUrl({ title: "Archive Hero", metadata: { adult: "all" } }, undefined, 1),
      chaptersUrl,
    ]);
  });

  it("resolves a retired persisted manga ID before loading and reading current chapters", async () => {
    const transport = new FakeTransport();
    const legacyManga = manga("retired-id");
    legacyManga.mangaInfo.primaryTitle = "Archive Hero";
    legacyManga.mangaInfo.secondaryTitles = ["Archive Hero’s Other Name"];
    delete legacyManga.mangaInfo.additionalInfo?.[CANONICAL_MANGA_ID_KEY];
    const searchUrl = buildSearchUrl(
      { title: "Archive Hero", metadata: { adult: "all" } },
      undefined,
      1,
    );
    transport.bodies.set(searchUrl, {
      found: 1,
      page: 1,
      hits: [{ document: { id: "oJQ4o", title: "Archive Hero", isAdult: false } }],
    });
    transport.bodies.set(buildAllChaptersUrl("retired-id"), {
      chapters: CHAPTERS_RESPONSE.chapters.slice(0, 1),
    });
    transport.bodies.set(buildAllChaptersUrl("oJQ4o"), CHAPTERS_RESPONSE);
    transport.bodies.set(buildChapterUrl("oJQ4o", "wZieNneB"), COMIC_CHAPTER_RESPONSE);
    const client = new AtsumaruClient(transport);

    const chapters = await client.getChapters(legacyManga);
    const currentChapter = chapters.find(({ chapterId }) => chapterId === "wZieNneB");
    assert.ok(currentChapter);
    assert.equal(chapters.length, 3);
    assert.ok(chapters.every(({ sourceManga }) => sourceManga.mangaId === "retired-id"));
    assert.ok(
      chapters.every(({ additionalInfo }) => additionalInfo?.[CANONICAL_MANGA_ID_KEY] === "oJQ4o"),
    );
    assert.equal((await client.getChapterDetails(currentChapter)).mangaId, "retired-id");
    assert.deepEqual(transport.calls, [
      searchUrl,
      buildAllChaptersUrl("oJQ4o"),
      buildChapterUrl("oJQ4o", "wZieNneB"),
    ]);
  });

  it("recovers chapters when the stored canonical ID has the wrong case", async () => {
    const transport = new FakeTransport();
    const sourceManga = manga("ojq4o");
    sourceManga.mangaInfo.primaryTitle = "Archive Hero";
    const searchUrl = buildSearchUrl(
      { title: "Archive Hero", metadata: { adult: "all" } },
      undefined,
      1,
    );
    transport.bodies.set(buildAllChaptersUrl("ojq4o"), { chapters: [] });
    transport.bodies.set(searchUrl, {
      found: 1,
      page: 1,
      hits: [{ document: { id: "oJQ4o", title: "Archive Hero", isAdult: false } }],
    });
    transport.bodies.set(buildAllChaptersUrl("oJQ4o"), CHAPTERS_RESPONSE);

    const chapters = await new AtsumaruClient(transport).getChapters(sourceManga);

    assert.deepEqual(
      chapters.map(({ chapterId }) => chapterId),
      ["h4j-gl", "wZieNneB", "_rmrsb"],
    );
    assert.ok(
      chapters.every(({ additionalInfo }) => additionalInfo?.[CANONICAL_MANGA_ID_KEY] === "oJQ4o"),
    );
    assert.deepEqual(transport.calls, [
      buildAllChaptersUrl("ojq4o"),
      searchUrl,
      buildAllChaptersUrl("oJQ4o"),
    ]);
  });

  it("recovers to the original manga ID when a retired canonical ID returns no chapters and title matching is ambiguous", async () => {
    const transport = new FakeTransport();
    const sourceManga = manga("oJQ4o");
    sourceManga.mangaInfo.primaryTitle = "Archive Hero";
    sourceManga.mangaInfo.additionalInfo = { [CANONICAL_MANGA_ID_KEY]: "retired-id" };
    const searchUrl = buildSearchUrl(
      { title: "Archive Hero", metadata: { adult: "all" } },
      undefined,
      1,
    );
    transport.bodies.set(buildAllChaptersUrl("retired-id"), { chapters: [] });
    transport.bodies.set(searchUrl, {
      found: 2,
      page: 1,
      hits: [
        { document: { id: "aaa1", title: "Archive Hero", isAdult: false } },
        { document: { id: "bbb2", title: "Archive Hero", isAdult: false } },
      ],
    });
    transport.bodies.set(buildAllChaptersUrl("oJQ4o"), CHAPTERS_RESPONSE);

    const chapters = await new AtsumaruClient(transport).getChapters(sourceManga);

    assert.deepEqual(
      chapters.map(({ chapterId }) => chapterId),
      ["h4j-gl", "wZieNneB", "_rmrsb"],
    );
    assert.ok(
      chapters.every(({ additionalInfo }) => additionalInfo?.[CANONICAL_MANGA_ID_KEY] === "oJQ4o"),
    );
    assert.deepEqual(transport.calls, [
      buildAllChaptersUrl("retired-id"),
      searchUrl,
      buildAllChaptersUrl("oJQ4o"),
    ]);
  });

  it("swallows a malformed title candidate and returns empty when the original ID has no chapters", async () => {
    const transport = new FakeTransport();
    const sourceManga = manga("oJQ4o");
    sourceManga.mangaInfo.primaryTitle = "Archive Hero";
    sourceManga.mangaInfo.additionalInfo = { [CANONICAL_MANGA_ID_KEY]: "retired-id" };
    const searchUrl = buildSearchUrl(
      { title: "Archive Hero", metadata: { adult: "all" } },
      undefined,
      1,
    );
    transport.bodies.set(buildAllChaptersUrl("retired-id"), { chapters: [] });
    transport.bodies.set(searchUrl, {
      found: 1,
      page: 1,
      hits: [{ document: { id: "AbC12", title: "Archive Hero", isAdult: false } }],
    });
    transport.bodies.set(buildAllChaptersUrl("oJQ4o"), { chapters: [] });
    transport.bodies.set(buildAllChaptersUrl("AbC12"), { chapters: null });

    const chapters = await new AtsumaruClient(transport).getChapters(sourceManga);

    assert.deepEqual(chapters, []);
    assert.deepEqual(transport.calls, [
      buildAllChaptersUrl("retired-id"),
      searchUrl,
      buildAllChaptersUrl("oJQ4o"),
      buildAllChaptersUrl("AbC12"),
    ]);
  });

  it("returns an empty list after bounded recovery when every candidate is chapterless", async () => {
    const transport = new FakeTransport();
    const sourceManga = manga("oJQ4o");
    sourceManga.mangaInfo.primaryTitle = "Archive Hero";
    sourceManga.mangaInfo.additionalInfo = { [CANONICAL_MANGA_ID_KEY]: "retired-id" };
    const searchUrl = buildSearchUrl(
      { title: "Archive Hero", metadata: { adult: "all" } },
      undefined,
      1,
    );
    transport.bodies.set(buildAllChaptersUrl("retired-id"), { chapters: [] });
    transport.bodies.set(searchUrl, {
      found: 1,
      page: 1,
      hits: [{ document: { id: "AbC12", title: "Archive Hero", isAdult: false } }],
    });
    transport.bodies.set(buildAllChaptersUrl("AbC12"), { chapters: [] });
    transport.bodies.set(buildAllChaptersUrl("oJQ4o"), { chapters: [] });

    const chapters = await new AtsumaruClient(transport).getChapters(sourceManga);

    assert.deepEqual(chapters, []);
    assert.deepEqual(transport.calls, [
      buildAllChaptersUrl("retired-id"),
      searchUrl,
      buildAllChaptersUrl("oJQ4o"),
      buildAllChaptersUrl("AbC12"),
    ]);
  });

  it("fetches the original ID once when title resolution returns that same ID", async () => {
    const transport = new FakeTransport();
    const sourceManga = manga("oJQ4o");
    sourceManga.mangaInfo.primaryTitle = "Archive Hero";
    sourceManga.mangaInfo.additionalInfo = { [CANONICAL_MANGA_ID_KEY]: "retired-id" };
    const searchUrl = buildSearchUrl(
      { title: "Archive Hero", metadata: { adult: "all" } },
      undefined,
      1,
    );
    transport.bodies.set(buildAllChaptersUrl("retired-id"), { chapters: [] });
    transport.bodies.set(searchUrl, {
      found: 1,
      page: 1,
      hits: [{ document: { id: "oJQ4o", title: "Archive Hero", isAdult: false } }],
    });
    transport.bodies.set(buildAllChaptersUrl("oJQ4o"), CHAPTERS_RESPONSE);

    const chapters = await new AtsumaruClient(transport).getChapters(sourceManga);

    assert.deepEqual(
      chapters.map(({ chapterId }) => chapterId),
      ["h4j-gl", "wZieNneB", "_rmrsb"],
    );
    assert.ok(
      chapters.every(({ additionalInfo }) => additionalInfo?.[CANONICAL_MANGA_ID_KEY] === "oJQ4o"),
    );
    assert.equal(transport.calls.filter((url) => url === buildAllChaptersUrl("oJQ4o")).length, 1);
    assert.deepEqual(transport.calls, [
      buildAllChaptersUrl("retired-id"),
      searchUrl,
      buildAllChaptersUrl("oJQ4o"),
    ]);
  });

  it("returns the original ID chapters without fetching the title candidate chapters", async () => {
    const transport = new FakeTransport();
    const sourceManga = manga("oJQ4o");
    sourceManga.mangaInfo.primaryTitle = "Archive Hero";
    sourceManga.mangaInfo.additionalInfo = { [CANONICAL_MANGA_ID_KEY]: "retired-id" };
    const searchUrl = buildSearchUrl(
      { title: "Archive Hero", metadata: { adult: "all" } },
      undefined,
      1,
    );
    transport.bodies.set(buildAllChaptersUrl("retired-id"), { chapters: [] });
    transport.bodies.set(searchUrl, {
      found: 1,
      page: 1,
      hits: [{ document: { id: "AbC12", title: "Archive Hero", isAdult: false } }],
    });
    transport.bodies.set(buildAllChaptersUrl("oJQ4o"), {
      chapters: [{ id: "orig-1", number: 1, createdAt: 1690000000000 }],
    });
    transport.bodies.set(buildAllChaptersUrl("AbC12"), {
      chapters: [{ id: "title-1", number: 1, createdAt: 1690000000000 }],
    });

    const chapters = await new AtsumaruClient(transport).getChapters(sourceManga);

    assert.deepEqual(
      chapters.map(({ chapterId }) => chapterId),
      ["orig-1"],
    );
    assert.ok(
      chapters.every(({ additionalInfo }) => additionalInfo?.[CANONICAL_MANGA_ID_KEY] === "oJQ4o"),
    );
    assert.equal(transport.calls.includes(buildAllChaptersUrl("AbC12")), false);
    assert.deepEqual(transport.calls, [
      buildAllChaptersUrl("retired-id"),
      searchUrl,
      buildAllChaptersUrl("oJQ4o"),
    ]);
  });

  it("rethrows the original ID failure when no recovery candidate returns chapters", async () => {
    const transport = new FakeTransport();
    const sourceManga = manga("oJQ4o");
    sourceManga.mangaInfo.primaryTitle = "Archive Hero";
    sourceManga.mangaInfo.additionalInfo = { [CANONICAL_MANGA_ID_KEY]: "retired-id" };
    const searchUrl = buildSearchUrl(
      { title: "Archive Hero", metadata: { adult: "all" } },
      undefined,
      1,
    );
    transport.bodies.set(buildAllChaptersUrl("retired-id"), { chapters: [] });
    transport.bodies.set(searchUrl, {
      found: 1,
      page: 1,
      hits: [{ document: { id: "AbC12", title: "Archive Hero", isAdult: false } }],
    });
    transport.bodies.set(
      buildAllChaptersUrl("oJQ4o"),
      new Error("original chapter transport failure"),
    );
    transport.bodies.set(buildAllChaptersUrl("AbC12"), { chapters: [] });

    await assert.rejects(
      new AtsumaruClient(transport).getChapters(sourceManga),
      /original chapter transport failure/,
    );
    assert.deepEqual(transport.calls, [
      buildAllChaptersUrl("retired-id"),
      searchUrl,
      buildAllChaptersUrl("oJQ4o"),
      buildAllChaptersUrl("AbC12"),
    ]);
  });

  it("returns title candidate chapters when the original ID recovery response is malformed", async () => {
    const transport = new FakeTransport();
    const sourceManga = manga("oJQ4o");
    sourceManga.mangaInfo.primaryTitle = "Archive Hero";
    sourceManga.mangaInfo.additionalInfo = { [CANONICAL_MANGA_ID_KEY]: "retired-id" };
    const searchUrl = buildSearchUrl(
      { title: "Archive Hero", metadata: { adult: "all" } },
      undefined,
      1,
    );
    transport.bodies.set(buildAllChaptersUrl("retired-id"), { chapters: [] });
    transport.bodies.set(searchUrl, {
      found: 1,
      page: 1,
      hits: [{ document: { id: "AbC12", title: "Archive Hero", isAdult: false } }],
    });
    transport.bodies.set(buildAllChaptersUrl("oJQ4o"), { chapters: null });
    transport.bodies.set(buildAllChaptersUrl("AbC12"), CHAPTERS_RESPONSE);

    const chapters = await new AtsumaruClient(transport).getChapters(sourceManga);

    assert.deepEqual(
      chapters.map(({ chapterId }) => chapterId),
      ["h4j-gl", "wZieNneB", "_rmrsb"],
    );
    assert.ok(
      chapters.every(({ additionalInfo }) => additionalInfo?.[CANONICAL_MANGA_ID_KEY] === "AbC12"),
    );
    assert.deepEqual(transport.calls, [
      buildAllChaptersUrl("retired-id"),
      searchUrl,
      buildAllChaptersUrl("oJQ4o"),
      buildAllChaptersUrl("AbC12"),
    ]);
  });

  it("makes no recovery requests when the stored canonical ID already returns chapters", async () => {
    const transport = new FakeTransport();
    const sourceManga = manga("oJQ4o");
    sourceManga.mangaInfo.primaryTitle = "Archive Hero";
    const chaptersUrl = buildAllChaptersUrl("oJQ4o");
    transport.bodies.set(chaptersUrl, CHAPTERS_RESPONSE);

    const chapters = await new AtsumaruClient(transport).getChapters(sourceManga);

    assert.deepEqual(
      chapters.map(({ chapterId }) => chapterId),
      ["h4j-gl", "wZieNneB", "_rmrsb"],
    );
    assert.deepEqual(transport.calls, [chaptersUrl]);
  });

  it("preserves scanlator labels across a Paperback JavaScript runtime reload", async () => {
    const detailTransport = new FakeTransport();
    setDetailResponses(detailTransport);
    const sourceManga = await new AtsumaruClient(detailTransport).getMangaDetails("oJQ4o");
    const persistedSourceManga = JSON.parse(JSON.stringify(sourceManga)) as SourceManga;
    const chapterTransport = new FakeTransport();
    const chaptersUrl = buildAllChaptersUrl("oJQ4o");
    chapterTransport.bodies.set(chaptersUrl, CHAPTERS_RESPONSE);

    const chapters = await new AtsumaruClient(chapterTransport).getChapters(persistedSourceManga);

    assert.equal(chapters[1]?.version, "Archive Team");
    assert.equal(chapters[1]?.sourceManga.mangaInfo.additionalInfo?.atsumaruScanlators, undefined);
    assert.deepEqual(chapterTransport.calls, [chaptersUrl]);
  });

  it("strips corrupt private scanlator metadata from chapter bridge payloads", async () => {
    const transport = new FakeTransport();
    transport.bodies.set(buildAllChaptersUrl("oJQ4o"), CHAPTERS_RESPONSE);
    const sourceManga = manga("oJQ4o");
    sourceManga.mangaInfo.additionalInfo = {
      atsumaruScanlators: "",
      [CANONICAL_MANGA_ID_KEY]: "oJQ4o",
    };

    const chapters = await new AtsumaruClient(transport).getChapters(sourceManga);

    assert.equal(
      Object.hasOwn(chapters[0]!.sourceManga.mangaInfo.additionalInfo ?? {}, "atsumaruScanlators"),
      false,
    );
  });

  it("evicts malformed chapter envelopes before retrying a corrected response", async () => {
    const transport = new FakeTransport();
    transport.bodies.set(buildMangaPageUrl("oJQ4o"), MANGA_PAGE_RESPONSE);
    const chaptersUrl = buildAllChaptersUrl("oJQ4o");
    transport.bodies.set(chaptersUrl, { chapters: null });
    const client = new AtsumaruClient(transport);

    await assert.rejects(client.getChapters(manga("oJQ4o")), /invalid chapters list/);

    transport.bodies.set(chaptersUrl, CHAPTERS_RESPONSE);
    assert.equal((await client.getChapters(manga("oJQ4o"))).length, 3);
    assert.equal(transport.calls.filter((url) => url === chaptersUrl).length, 2);
  });

  it("returns backfilled chapters even when Paperback supplies a since-date", async () => {
    const transport = new FakeTransport();
    transport.bodies.set(buildMangaPageUrl("oJQ4o"), MANGA_PAGE_RESPONSE);
    transport.bodies.set(buildAllChaptersUrl("oJQ4o"), CHAPTERS_RESPONSE);
    const client = new AtsumaruClient(transport);

    const all = await client.getChapters(manga("oJQ4o"), undefined, true);
    const afterEveryRecordedTimestamp = await client.getChapters(
      manga("oJQ4o"),
      new Date(2_000_000_000_000),
      true,
    );
    assert.deepEqual(afterEveryRecordedTimestamp, all);

    const invalid = await client.getChapters(manga("oJQ4o"), new Date(Number.NaN), true);
    assert.deepEqual(invalid, all);
  });

  it("advances home offsets by consumed API records when malformed cards are skipped", async () => {
    const transport = new FakeTransport();
    const preferences = { limit: 2 };
    transport.bodies.set(buildHomeUrl("popular", { ...preferences, offset: 10 }), {
      items: [{ id: "oJQ4o", title: "Readable" }, { id: "malformed-without-title" }],
    });
    const page = await new AtsumaruClient(transport).getHomePage("popular", 10, preferences);

    assert.equal(page.items.length, 1);
    assert.equal(page.hasNextPage, true);
    assert.equal(page.nextOffset, 12);
  });

  it("dispatches comic and novel readers without caching mutable reader payloads", async () => {
    const transport = new FakeTransport();
    transport.bodies.set(buildChapterUrl("oJQ4o", "wZieNneB"), COMIC_CHAPTER_RESPONSE);
    transport.bodies.set(buildNovelChapterUrl("N7JpR", "zFL0iqq"), NOVEL_CHAPTER_RESPONSE);
    const client = new AtsumaruClient(transport);
    const comic: Chapter = {
      chapterId: "wZieNneB",
      sourceManga: manga("oJQ4o"),
      langCode: "en",
      chapNum: 2,
    };
    const novel: Chapter = {
      chapterId: "zFL0iqq",
      sourceManga: manga("N7JpR", "novel"),
      langCode: "en",
      chapNum: 5,
    };

    assert.ok("pages" in (await client.getChapterDetails(comic)));
    assert.equal((await client.getChapterDetails(novel)).type, "html");
    await client.getChapterDetails(comic);
    assert.equal(
      transport.calls.filter((url) => url === buildChapterUrl("oJQ4o", "wZieNneB")).length,
      2,
    );
  });

  it("falls back to the source manga format when dispatch metadata is absent", async () => {
    const transport = new FakeTransport();
    const novelUrl = buildNovelChapterUrl("N7JpR", "zFL0iqq");
    transport.bodies.set(novelUrl, NOVEL_CHAPTER_RESPONSE);
    const client = new AtsumaruClient(transport);
    const source = manga("N7JpR");
    const novelFallback: SourceManga = {
      ...source,
      mangaInfo: {
        ...source.mangaInfo,
        contentType: undefined,
        additionalInfo: { format: "Novel", [CANONICAL_MANGA_ID_KEY]: "N7JpR" },
      },
    };
    const chapter: Chapter = {
      chapterId: "zFL0iqq",
      sourceManga: novelFallback,
      langCode: "en",
      chapNum: 5,
    };

    assert.equal((await client.getChapterDetails(chapter)).type, "html");
    assert.deepEqual(transport.calls, [novelUrl]);
  });

  it("does not cache failures and clears every metadata cache explicitly", async () => {
    const transport = new FakeTransport();
    const url = buildMangaPageUrl("oJQ4o");
    transport.bodies.set(url, new Error("temporary"));
    transport.bodies.set(
      buildMangaRatingUrl("oJQ4o"),
      ratingResponse({
        id: "oJQ4o",
        isAdult: false,
        mbContentRating: "Safe",
      }),
    );
    const client = new AtsumaruClient(transport);
    await assert.rejects(client.getMangaDetails("oJQ4o"), /temporary/);

    transport.bodies.set(url, MANGA_PAGE_RESPONSE);
    await client.getMangaDetails("oJQ4o");
    assert.equal(transport.calls.filter((requestUrl) => requestUrl === url).length, 2);
    assert.equal(
      transport.calls.filter((requestUrl) => requestUrl === buildMangaRatingUrl("oJQ4o")).length,
      1,
    );
    client.invalidateCaches();
    await client.getMangaDetails("oJQ4o");
    assert.equal(transport.calls.filter((requestUrl) => requestUrl === url).length, 3);
    assert.equal(
      transport.calls.filter((requestUrl) => requestUrl === buildMangaRatingUrl("oJQ4o")).length,
      2,
    );
  });

  it("caches completed zero-hit absence and retries transient failures", async () => {
    const transport = new FakeTransport();
    const pageUrl = buildMangaPageUrl("oJQ4o");
    const ratingUrl = buildMangaRatingUrl("oJQ4o");
    transport.bodies.set(pageUrl, MANGA_PAGE_RESPONSE);
    transport.bodies.set(ratingUrl, ratingResponse());
    const client = new AtsumaruClient(transport);

    const missingFirst = await client.getMangaDetails("oJQ4o");
    const missingSecond = await client.getMangaDetails("oJQ4o");
    assert.equal(missingFirst.mangaInfo.contentRating, ContentRating.MATURE);
    assert.equal(missingSecond.mangaInfo.contentRating, ContentRating.MATURE);
    assert.equal(transport.calls.filter((url) => url === ratingUrl).length, 1);

    client.invalidateCaches();
    transport.bodies.set(ratingUrl, new Error("temporary rating outage"));
    const outageFallback = await client.getMangaDetails("oJQ4o");
    assert.equal(outageFallback.mangaInfo.contentRating, ContentRating.MATURE);
    transport.bodies.set(
      ratingUrl,
      ratingResponse({
        id: "oJQ4o",
        isAdult: false,
        mbContentRating: "Erotica",
      }),
    );
    const recovered = await client.getMangaDetails("oJQ4o");
    assert.equal(recovered.mangaInfo.contentRating, ContentRating.ADULT);
    assert.equal(transport.calls.filter((url) => url === ratingUrl).length, 3);
  });

  it("does not cache an untyped failure merely because its text resembles a 404", async () => {
    const transport = new FakeTransport();
    const ratingUrl = buildMangaRatingUrl("oJQ4o");
    setDetailResponses(transport);
    transport.bodies.set(ratingUrl, new Error("Atsumaru content was not found."));
    const client = new AtsumaruClient(transport);

    await client.getMangaDetails("oJQ4o");
    transport.bodies.set(
      ratingUrl,
      ratingResponse({
        id: "oJQ4o",
        isAdult: false,
        mbContentRating: "Erotica",
      }),
    );
    const recovered = await client.getMangaDetails("oJQ4o");

    assert.equal(recovered.mangaInfo.contentRating, ContentRating.ADULT);
    assert.equal(transport.calls.filter((url) => url === ratingUrl).length, 2);
  });

  it("does not cache an invalid rating document identity", async () => {
    const transport = new FakeTransport();
    const ratingUrl = buildMangaRatingUrl("oJQ4o");
    setDetailResponses(transport, "oJQ4o", MANGA_PAGE_RESPONSE, {
      id: "different-series",
      isAdult: false,
      mbContentRating: "Pornographic",
    });
    const client = new AtsumaruClient(transport);

    const fallback = await client.getMangaDetails("oJQ4o");
    assert.equal(fallback.mangaInfo.contentRating, ContentRating.MATURE);
    transport.bodies.set(
      ratingUrl,
      ratingResponse({
        id: "oJQ4o",
        isAdult: false,
        mbContentRating: "Erotica",
      }),
    );
    const recovered = await client.getMangaDetails("oJQ4o");
    assert.equal(recovered.mangaInfo.contentRating, ContentRating.ADULT);
    assert.equal(transport.calls.filter((url) => url === ratingUrl).length, 2);
  });

  it("caches a verified same-ID document even when mbContentRating is absent", async () => {
    const transport = new FakeTransport();
    const ratingUrl = buildMangaRatingUrl("oJQ4o");
    setDetailResponses(transport, "oJQ4o", MANGA_PAGE_RESPONSE, {
      id: "oJQ4o",
      isAdult: false,
    });
    const client = new AtsumaruClient(transport);

    const first = await client.getMangaDetails("oJQ4o");
    transport.bodies.set(
      ratingUrl,
      ratingResponse({
        id: "oJQ4o",
        isAdult: false,
        mbContentRating: "Erotica",
      }),
    );
    const second = await client.getMangaDetails("oJQ4o");

    assert.equal(first.mangaInfo.contentRating, ContentRating.MATURE);
    assert.equal(second.mangaInfo.contentRating, ContentRating.MATURE);
    assert.equal(transport.calls.filter((url) => url === ratingUrl).length, 1);
  });

  it("starts page and reduced rating requests together and passes a small body cap", async () => {
    const transport = new FakeTransport();
    setDetailResponses(transport, "oJQ4o", MANGA_PAGE_RESPONSE, {
      id: "oJQ4o",
      isAdult: false,
      mbContentRating: "Erotica",
    });
    const client = new AtsumaruClient(transport);

    const details = await client.getMangaDetails("oJQ4o");

    assert.equal(details.mangaInfo.contentRating, ContentRating.ADULT);
    assert.deepEqual(transport.options[transport.calls.indexOf(buildMangaRatingUrl("oJQ4o"))], {
      maxBytes: 1_024,
    });
    assert.deepEqual(transport.calls.slice(0, 2), [
      buildMangaPageUrl("oJQ4o"),
      buildMangaRatingUrl("oJQ4o"),
    ]);
  });

  it("retries rejected rating searches and recovers to ADULT rather than caching absence", async () => {
    for (const failure of [
      new SourceHttpError("Atsumaru", 404),
      new SourceHttpError("Atsumaru", 429),
      new SourceHttpError("Atsumaru", 503),
      new Error("transport unavailable"),
      { ...ratingResponse(), search_cutoff: true },
      { ...ratingResponse(), page: 2 },
      { found: 0, hits: [] },
      ratingResponse({ id: "oJq4o", mbContentRating: "Safe" }),
      { error: "invalid search" },
    ]) {
      const transport = new FakeTransport();
      setDetailResponses(transport);
      const url = buildMangaRatingUrl("oJQ4o");
      transport.bodies.set(url, failure);
      const client = new AtsumaruClient(transport);
      assert.equal(
        (await client.getMangaDetails("oJQ4o")).mangaInfo.contentRating,
        ContentRating.MATURE,
      );
      transport.bodies.set(url, ratingResponse({ id: "oJQ4o", mbContentRating: "Erotica" }));
      assert.equal(
        (await client.getMangaDetails("oJQ4o")).mangaInfo.contentRating,
        ContentRating.ADULT,
      );
      assert.equal(transport.calls.filter((value) => value === url).length, 2);
    }
  });

  it("evicts the oldest rating after 64 distinct series", async () => {
    const transport = new FakeTransport();
    const client = new AtsumaruClient(transport);
    for (let index = 0; index < 65; index += 1) {
      const id = `series-${index}`;
      setDetailResponses(transport, id, {
        mangaPage: { ...MANGA_PAGE_RESPONSE.mangaPage, id },
      });
      assert.equal(
        (await client.getMangaDetails(id)).mangaInfo.contentRating,
        ContentRating.EVERYONE,
      );
    }
    transport.bodies.set(
      buildMangaRatingUrl("series-0"),
      ratingResponse({ id: "series-0", isAdult: true }),
    );
    assert.equal(
      (await client.getMangaDetails("series-0")).mangaInfo.contentRating,
      ContentRating.ADULT,
    );
    assert.equal(
      transport.calls.filter((url) => url === buildMangaRatingUrl("series-0")).length,
      2,
    );
  });

  it("uses real transport limits and retries HTML, invalid JSON, oversized bodies and foreign redirects", async () => {
    const url = buildMangaRatingUrl("oJQ4o");
    for (const failure of [
      { body: "<html><title>Atsumaru</title></html>", url },
      { body: "{invalid", url },
      { body: "x".repeat(1_025), url },
      {
        body: JSON.stringify(ratingResponse({ id: "oJQ4o", isAdult: true })),
        url: "https://example.com/rating",
      },
    ]) {
      let recover = false;
      let ratingCalls = 0;
      let oversizedDecoded = false;
      Object.assign(globalThis, {
        Application: {
          arrayBufferToUTF8String: (buffer: ArrayBuffer) => {
            if (buffer.byteLength === 1_025) oversizedDecoded = true;
            return new TextDecoder().decode(buffer);
          },
          scheduleRequest: async (request: Request) => {
            const isRating = request.url === url;
            if (isRating) ratingCalls += 1;
            const body = isRating
              ? recover
                ? JSON.stringify(ratingResponse({ id: "oJQ4o", isAdult: true }))
                : failure.body
              : JSON.stringify(MANGA_PAGE_RESPONSE);
            return [
              {
                url: isRating && !recover ? failure.url : request.url,
                status: 200,
                headers: {},
                cookies: [],
              },
              new TextEncoder().encode(body).buffer,
            ];
          },
        },
      });
      const client = new AtsumaruClient();
      assert.equal(
        (await client.getMangaDetails("oJQ4o")).mangaInfo.contentRating,
        ContentRating.MATURE,
      );
      recover = true;
      assert.equal(
        (await client.getMangaDetails("oJQ4o")).mangaInfo.contentRating,
        ContentRating.ADULT,
      );
      assert.equal(ratingCalls, 2);
      assert.equal(oversizedDecoded, false);
    }
  });

  it("retains verified ratings and completed absence for 120 seconds, then refreshes", async (context) => {
    let now = 0;
    context.mock.method(Date, "now", () => now);
    for (const initial of [null, { id: "oJQ4o", mbContentRating: "Safe" }]) {
      now = 0;
      const transport = new FakeTransport();
      setDetailResponses(transport, "oJQ4o", MANGA_PAGE_RESPONSE, initial);
      const client = new AtsumaruClient(transport);
      const expected = initial === null ? ContentRating.MATURE : ContentRating.EVERYONE;
      assert.equal((await client.getMangaDetails("oJQ4o")).mangaInfo.contentRating, expected);
      transport.bodies.set(
        buildMangaRatingUrl("oJQ4o"),
        ratingResponse({ id: "oJQ4o", isAdult: true }),
      );
      now = 119_999;
      assert.equal((await client.getMangaDetails("oJQ4o")).mangaInfo.contentRating, expected);
      now = 120_000;
      assert.equal(
        (await client.getMangaDetails("oJQ4o")).mangaInfo.contentRating,
        ContentRating.ADULT,
      );
    }
  });

  it("selects the newest alternate and breaks equal timestamps by ID for zero and fractional chapters", async () => {
    const transport = new FakeTransport();
    transport.bodies.set(buildAllChaptersUrl("oJQ4o"), {
      chapters: [
        { id: "zero-a", number: 0, createdAt: 1700000000000 },
        { id: "zero-z", number: 0, createdAt: 1700000000000 },
        { id: "half-old", number: 0.5, createdAt: 1690000000000 },
        { id: "half-new", number: 0.5, createdAt: 1700000000000 },
      ],
    });
    const client = new AtsumaruClient(transport);
    const chapters = await client.getChapters(manga("oJQ4o"), new Date(1800000000000), false);
    assert.deepEqual(
      chapters.map(({ chapterId, chapNum, sortingIndex }) => [chapterId, chapNum, sortingIndex]),
      [
        ["zero-z", 0, 0],
        ["half-new", 0.5, 1],
      ],
    );
  });
});
