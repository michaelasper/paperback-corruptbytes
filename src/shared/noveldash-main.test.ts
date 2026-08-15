import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  ContentRating,
  DiscoverSectionType,
  type Chapter,
  type ChapterDetails,
  type Cookie,
  type DiscoverSection,
  type PagedResults,
  type SearchQuery,
  type SearchResultItem,
  type SortingOption,
  type SourceManga,
  type Tag,
} from "@paperback/types";

import {
  NOVELDASH_SECTIONS,
  NOVELDASH_SORTING_OPTIONS,
  NovelDashExtension,
  type NovelDashClientContract,
} from "./noveldash-main.js";
import type { NovelDashSearchMetadata } from "./noveldash-models.js";
import type { ParsedNovelDashCatalog } from "./noveldash-parsers.js";
import { NOVELDASH_TEST_SITE } from "./noveldash-test-fixtures.js";

const originalApplication = globalThis.Application;
let state = new Map<string, unknown>();
let secureState = new Map<string, unknown>();

const mangaFixture = (): SourceManga => ({
  mangaId: "comic%40route-slug",
  mangaInfo: {
    primaryTitle: "Fixture Comic",
    secondaryTitles: [],
    thumbnailUrl: "https://media.fixture.example/cover.webp",
    synopsis: "Fixture synopsis",
    contentRating: ContentRating.MATURE,
  },
});

class FakeClient implements NovelDashClientContract {
  catalogCalls: [SearchQuery<NovelDashSearchMetadata>, SortingOption | undefined, number][] = [];
  chapterOptions: { showLocked?: boolean; sinceDate?: Date }[] = [];
  invalidations = 0;

  async getCatalogPage(
    query: SearchQuery<NovelDashSearchMetadata>,
    sorting: SortingOption | undefined,
    page: number,
  ): Promise<ParsedNovelDashCatalog> {
    this.catalogCalls.push([query, sorting, page]);
    return {
      items: [
        {
          mangaId: "comic%40route-slug",
          title: "Fixture Comic",
          imageUrl: "https://media.fixture.example/cover.webp",
          contentRating: ContentRating.MATURE,
          type: "Manhwa",
          status: "Ongoing",
          rating: 0.9,
          isHot: true,
          genres: ["Drama"],
          latestChapterId: "chapter-3",
          latestChapterNumber: 3,
          latestChapterTitle: "Chapter 3",
          latestPublishDate: new Date("2026-08-01T00:00:00Z"),
        },
      ],
      total: 48,
      page,
      totalPages: 2,
      hasMore: page < 2,
    };
  }

  async getGenres(): Promise<Tag[]> {
    return [
      { id: "action", title: "Action" },
      { id: "adult", title: "Adult" },
    ];
  }

  async getMangaDetails(_mangaId: string): Promise<SourceManga> {
    return mangaFixture();
  }

  async getChapters(
    manga: SourceManga,
    options?: { showLocked?: boolean; sinceDate?: Date },
  ): Promise<Chapter[]> {
    this.chapterOptions.push(options ?? {});
    return [
      {
        chapterId: options?.showLocked ? "locked-visible" : "free-only",
        sourceManga: manga,
        langCode: "en",
        chapNum: 1,
      },
    ];
  }

  async getChapterDetails(chapter: Chapter): Promise<ChapterDetails> {
    return {
      id: chapter.chapterId,
      mangaId: chapter.sourceManga.mangaId,
      pages: ["https://media.fixture.example/page.webp"],
    };
  }

  async resolvePastedUrl(query: string): Promise<PagedResults<SearchResultItem> | undefined> {
    return query.startsWith("https://")
      ? {
          items: [
            {
              mangaId: "comic%40pasted",
              title: "Pasted",
              imageUrl: "https://media.fixture.example/pasted.webp",
              contentRating: ContentRating.EVERYONE,
            },
          ],
        }
      : undefined;
  }

  invalidateCaches(): void {
    this.invalidations += 1;
  }
}

beforeEach(() => {
  state = new Map();
  secureState = new Map();
  Object.assign(globalThis, {
    Application: {
      Selector: () => "selector",
      formDidChange: () => undefined,
      getState: (key: string) => state.get(key),
      setState: (value: unknown, key: string) => state.set(key, value),
      getSecureState: (key: string) => secureState.get(key),
      setSecureState: (value: unknown, key: string) => secureState.set(key, value),
    },
  });
});

afterEach(() => {
  Object.assign(globalThis, { Application: originalApplication });
});

describe("NovelDashExtension", () => {
  it("maps every discovery section and preserves catalog pagination", async () => {
    const client = new FakeClient();
    const extension = new NovelDashExtension(NOVELDASH_TEST_SITE, client);
    const sections = await extension.getDiscoverSections();
    const byId = (id: string): DiscoverSection => sections.find((section) => section.id === id)!;

    assert.deepEqual(
      sections.map((section) => section.id),
      [
        NOVELDASH_SECTIONS.LATEST,
        NOVELDASH_SECTIONS.TRENDING,
        NOVELDASH_SECTIONS.NEW,
        NOVELDASH_SECTIONS.GENRES,
      ],
    );
    const latest = await extension.getDiscoverSectionItems(
      byId(NOVELDASH_SECTIONS.LATEST),
      undefined,
    );
    const trending = await extension.getDiscoverSectionItems(byId(NOVELDASH_SECTIONS.TRENDING), {
      page: 2,
    });
    const recentlyAdded = await extension.getDiscoverSectionItems(
      byId(NOVELDASH_SECTIONS.NEW),
      undefined,
    );
    const genres = await extension.getDiscoverSectionItems(
      byId(NOVELDASH_SECTIONS.GENRES),
      undefined,
    );

    assert.equal(latest.items[0]?.type, "chapterUpdatesCarouselItem");
    assert.deepEqual(latest.metadata, { page: 2 });
    assert.equal(trending.items[0]?.type, "featuredCarouselItem");
    assert.equal(trending.metadata, undefined);
    assert.equal(recentlyAdded.items[0]?.type, "prominentCarouselItem");
    assert.equal(genres.items[1]?.type, "genresCarouselItem");
    assert.equal(genres.items[1]?.contentRating, ContentRating.ADULT);
    assert.deepEqual(
      client.catalogCalls.map(([, sorting, page]) => [sorting?.id, page]),
      [
        ["updated", 1],
        ["trending", 2],
        ["newest", 1],
      ],
    );
  });

  it("does not request data for an unknown discovery section", async () => {
    const client = new FakeClient();
    const extension = new NovelDashExtension(NOVELDASH_TEST_SITE, client);
    const result = await extension.getDiscoverSectionItems(
      { id: "unknown", title: "Unknown", type: DiscoverSectionType.simpleCarousel },
      undefined,
    );

    assert.deepEqual(result, { items: [] });
    assert.equal(client.catalogCalls.length, 0);
  });

  it("maps search, pasted URLs, sorting, details, and the locked preference", async () => {
    const client = new FakeClient();
    const extension = new NovelDashExtension(NOVELDASH_TEST_SITE, client);
    const searched = await extension.getSearchResults({ title: "fixture" }, undefined, {
      id: "views",
      label: "Most viewed",
    });
    const pasted = await extension.getSearchResults(
      { title: "https://fixture.example/series/comic/pasted" },
      undefined,
    );
    const manga = await extension.getMangaDetails("comic%40route-slug");
    const visible = await extension.getChapters(manga);
    state.set("fixture_scans.show_locked_chapters", false);
    const hidden = await extension.getChapters(manga, new Date("2026-08-01T00:00:00Z"));

    assert.equal(searched.items[0]?.title, "Fixture Comic");
    assert.deepEqual(searched.metadata, { page: 2 });
    assert.equal(pasted.items[0]?.title, "Pasted");
    assert.deepEqual(await extension.getSortingOptions({ title: "" }), NOVELDASH_SORTING_OPTIONS);
    assert.equal(visible[0]?.chapterId, "locked-visible");
    assert.equal(hidden[0]?.chapterId, "free-only");
    assert.equal(client.chapterOptions[0]?.showLocked, true);
    assert.equal(client.chapterOptions[1]?.showLocked, false);
    assert.equal(client.chapterOptions[1]?.sinceDate?.toISOString(), "2026-08-01T00:00:00.000Z");
  });

  it("stores only source cookies after a Cloudflare bypass and invalidates caches", async () => {
    const client = new FakeClient();
    const extension = new NovelDashExtension(NOVELDASH_TEST_SITE, client);
    const cookies: Cookie[] = [
      { name: "cf_clearance", value: "clear", domain: ".fixture.example", path: "/" },
      { name: "foreign", value: "no", domain: "evil.example", path: "/" },
    ];

    await extension.cloudflareBypassCompleted(
      { url: "https://fixture.example/", method: "GET" },
      cookies,
      {},
    );

    assert.equal(client.invalidations, 1);
    assert.deepEqual(secureState.get("fixture_scans.secure_cookies"), [cookies[0]]);
  });
});
