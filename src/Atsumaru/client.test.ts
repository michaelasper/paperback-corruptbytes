import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ContentRating, type Chapter, type Request, type SourceManga } from "@paperback/types";

import { SourceHttpError } from "../shared/http.js";
import { AtsumaruClient, AVAILABLE_FILTERS_MAX_BYTES, type AtsumaruTransport } from "./client.js";
import type { AtsumaruFetchBodyOptions } from "./network.js";
import {
  AVAILABLE_FILTERS_URL,
  buildAllChaptersUrl,
  buildChapterUrl,
  buildHomeUrl,
  buildMangaDocumentUrl,
  buildMangaPageUrl,
  buildNovelChapterUrl,
} from "./network.js";
import {
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

const manga = (mangaId: string, contentType: "comic" | "novel" = "comic"): SourceManga => ({
  mangaId,
  mangaInfo: {
    primaryTitle: "Archive title",
    secondaryTitles: [],
    thumbnailUrl: "https://cdn.atsu.moe/static/posters/archive.webp",
    synopsis: "",
    contentRating: ContentRating.EVERYONE,
    contentType,
  },
});

const setDetailResponses = (
  transport: FakeTransport,
  mangaId = "oJQ4o",
  page: unknown = MANGA_PAGE_RESPONSE,
  rating: unknown = { id: mangaId, isAdult: false, mbContentRating: "Safe" },
): void => {
  transport.bodies.set(buildMangaPageUrl(mangaId), page);
  transport.bodies.set(buildMangaDocumentUrl(mangaId), rating);
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
    assert.equal(transport.calls.filter((url) => url === buildMangaDocumentUrl("oJQ4o")).length, 1);
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
    transport.bodies.set(buildMangaDocumentUrl("oJQ4o"), {
      id: "oJQ4o",
      isAdult: false,
      mbContentRating: "Safe",
    });
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
    assert.equal(new Set(oneTranslation.map(({ chapNum }) => chapNum)).size, oneTranslation.length);
  });

  it("does not make authoritative chapters depend on auxiliary manga-page metadata", async () => {
    const transport = new FakeTransport();
    const chaptersUrl = buildAllChaptersUrl("oJQ4o");
    transport.bodies.set(chaptersUrl, CHAPTERS_RESPONSE);
    const client = new AtsumaruClient(transport);

    const chapters = await client.getChapters(manga("oJQ4o"));

    assert.equal(chapters.length, 3);
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
    sourceManga.mangaInfo.additionalInfo = { atsumaruScanlators: "" };

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
        additionalInfo: { format: "Novel" },
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
    transport.bodies.set(buildMangaDocumentUrl("oJQ4o"), {
      id: "oJQ4o",
      isAdult: false,
      mbContentRating: "Safe",
    });
    const client = new AtsumaruClient(transport);
    await assert.rejects(client.getMangaDetails("oJQ4o"), /temporary/);

    transport.bodies.set(url, MANGA_PAGE_RESPONSE);
    await client.getMangaDetails("oJQ4o");
    assert.equal(transport.calls.filter((requestUrl) => requestUrl === url).length, 2);
    assert.equal(
      transport.calls.filter((requestUrl) => requestUrl === buildMangaDocumentUrl("oJQ4o")).length,
      1,
    );
    client.invalidateCaches();
    await client.getMangaDetails("oJQ4o");
    assert.equal(transport.calls.filter((requestUrl) => requestUrl === url).length, 3);
    assert.equal(
      transport.calls.filter((requestUrl) => requestUrl === buildMangaDocumentUrl("oJQ4o")).length,
      2,
    );
  });

  it("maps rating authority, caches a missing document, and retries transient failures", async () => {
    const transport = new FakeTransport();
    const pageUrl = buildMangaPageUrl("oJQ4o");
    const ratingUrl = buildMangaDocumentUrl("oJQ4o");
    transport.bodies.set(pageUrl, MANGA_PAGE_RESPONSE);
    transport.bodies.set(ratingUrl, new SourceHttpError("Atsumaru", 404));
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
    transport.bodies.set(ratingUrl, {
      id: "oJQ4o",
      isAdult: false,
      mbContentRating: "Suggestive",
    });
    const recovered = await client.getMangaDetails("oJQ4o");
    assert.equal(recovered.mangaInfo.contentRating, ContentRating.MATURE);
    assert.equal(transport.calls.filter((url) => url === ratingUrl).length, 3);
  });

  it("does not cache an untyped failure merely because its text resembles a 404", async () => {
    const transport = new FakeTransport();
    const ratingUrl = buildMangaDocumentUrl("oJQ4o");
    setDetailResponses(transport);
    transport.bodies.set(ratingUrl, new Error("Atsumaru content was not found."));
    const client = new AtsumaruClient(transport);

    await client.getMangaDetails("oJQ4o");
    transport.bodies.set(ratingUrl, {
      id: "oJQ4o",
      isAdult: false,
      mbContentRating: "Suggestive",
    });
    const recovered = await client.getMangaDetails("oJQ4o");

    assert.equal(recovered.mangaInfo.contentRating, ContentRating.MATURE);
    assert.equal(transport.calls.filter((url) => url === ratingUrl).length, 2);
  });

  it("does not cache an invalid rating document identity", async () => {
    const transport = new FakeTransport();
    const ratingUrl = buildMangaDocumentUrl("oJQ4o");
    setDetailResponses(transport, "oJQ4o", MANGA_PAGE_RESPONSE, {
      id: "different-series",
      isAdult: false,
      mbContentRating: "Pornographic",
    });
    const client = new AtsumaruClient(transport);

    const fallback = await client.getMangaDetails("oJQ4o");
    assert.equal(fallback.mangaInfo.contentRating, ContentRating.MATURE);
    transport.bodies.set(ratingUrl, {
      id: "oJQ4o",
      isAdult: false,
      mbContentRating: "Suggestive",
    });
    const recovered = await client.getMangaDetails("oJQ4o");
    assert.equal(recovered.mangaInfo.contentRating, ContentRating.MATURE);
    assert.equal(transport.calls.filter((url) => url === ratingUrl).length, 2);
  });

  it("caches a verified same-ID document even when mbContentRating is absent", async () => {
    const transport = new FakeTransport();
    const ratingUrl = buildMangaDocumentUrl("oJQ4o");
    setDetailResponses(transport, "oJQ4o", MANGA_PAGE_RESPONSE, {
      id: "oJQ4o",
      isAdult: false,
    });
    const client = new AtsumaruClient(transport);

    const first = await client.getMangaDetails("oJQ4o");
    transport.bodies.set(ratingUrl, {
      id: "oJQ4o",
      isAdult: false,
      mbContentRating: "Suggestive",
    });
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
      mbContentRating: "Suggestive",
    });
    const client = new AtsumaruClient(transport);

    const details = await client.getMangaDetails("oJQ4o");

    assert.equal(details.mangaInfo.contentRating, ContentRating.MATURE);
    assert.deepEqual(transport.options[transport.calls.indexOf(buildMangaDocumentUrl("oJQ4o"))], {
      maxBytes: 1_024,
    });
    assert.deepEqual(transport.calls.slice(0, 2), [
      buildMangaPageUrl("oJQ4o"),
      buildMangaDocumentUrl("oJQ4o"),
    ]);
  });
});
