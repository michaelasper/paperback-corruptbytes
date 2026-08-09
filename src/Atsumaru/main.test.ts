import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  ContentRating,
  DiscoverSectionType,
  type Chapter,
  type ChapterDetails,
  type PagedResults,
  type Request,
  type SearchQuery,
  type SearchResultItem,
  type SortingOption,
  type SourceManga,
} from "@paperback/types";

import {
  AtsumaruExtension,
  SECTIONS,
  SORTING_OPTIONS,
  type AtsumaruClientContract,
} from "./main.js";
import type {
  AtsumaruCatalogPage,
  AtsumaruDiscoveryPreferences,
  AtsumaruFilterOptions,
  AtsumaruHomeFeed,
  AtsumaruSearchMetadata,
} from "./models.js";

const originalApplication = globalThis.Application;
let state: Map<string, unknown>;

beforeEach(() => {
  state = new Map();
  Object.assign(globalThis, {
    Application: {
      Selector: (_form: unknown, method: string) => method,
      getState: (key: string) => state.get(key),
      setState: (value: unknown, key: string) => state.set(key, value),
      getSecureState: (key: string) => state.get(key),
      setSecureState: (value: unknown, key: string) => state.set(key, value),
    },
  });
});

afterEach(() => Object.assign(globalThis, { Application: originalApplication }));

const card = () => ({
  mangaId: "oJQ4o",
  title: "Pick Me Up",
  imageUrl: "https://cdn.atsu.moe/static/posters/pick-me-up.webp",
  contentRating: ContentRating.MATURE,
  contentType: "comic",
  type: "Manwha",
  medium: "Comic",
  rating: 0.84,
  views: 6_700_000,
  chapterCount: 213,
});

class FakeClient implements AtsumaruClientContract {
  filterCalls = 0;
  filterFailure?: Error;
  invalidateCalls = 0;
  readonly filterOptions: AtsumaruFilterOptions = {
    genres: [
      { id: "39", name: "Action" },
      { id: "46", name: "Adult" },
    ],
    tags: [{ id: "250", name: "Murder", group: "Activities", adult: false }],
    tagGroups: [
      {
        id: "Activities",
        name: "Activities",
        tags: [{ id: "250", name: "Murder", group: "Activities", adult: false }],
      },
    ],
    types: [{ id: "Manwha", name: "Manhwa" }],
    statuses: [{ id: "Ongoing", name: "Ongoing" }],
    mediums: [
      { id: "Comic", name: "Comic" },
      { id: "Novel", name: "Novel" },
    ],
  };
  readonly homeCalls: {
    feed: AtsumaruHomeFeed;
    offset: number;
    preferences: AtsumaruDiscoveryPreferences;
  }[] = [];
  readonly searchCalls: {
    query: SearchQuery<AtsumaruSearchMetadata>;
    sorting?: SortingOption;
    page: number;
  }[] = [];
  chapterArguments?: { sinceDate?: Date; includeAlternates: boolean };

  async getHomePage(
    feed: AtsumaruHomeFeed,
    offset: number,
    preferences: AtsumaruDiscoveryPreferences,
  ): Promise<AtsumaruCatalogPage> {
    this.homeCalls.push({ feed, offset, preferences });
    return { items: [card()], offset, nextOffset: offset + 24, hasNextPage: offset === 0 };
  }

  async getSearchPage(
    query: SearchQuery<AtsumaruSearchMetadata>,
    sorting: SortingOption | undefined,
    page: number,
  ): Promise<AtsumaruCatalogPage> {
    this.searchCalls.push({ query, sorting, page });
    return { items: [card()], page, hasNextPage: page === 1 };
  }

  async getFilterOptions(): Promise<AtsumaruFilterOptions> {
    this.filterCalls += 1;
    if (this.filterFailure) {
      const failure = this.filterFailure;
      this.filterFailure = undefined;
      throw failure;
    }
    return this.filterOptions;
  }

  async getMangaDetails(mangaId: string): Promise<SourceManga> {
    return {
      mangaId,
      mangaInfo: {
        primaryTitle: "Pick Me Up",
        secondaryTitles: [],
        thumbnailUrl: card().imageUrl,
        synopsis: "",
        contentRating: ContentRating.MATURE,
      },
    };
  }

  async getChapters(
    _sourceManga: SourceManga,
    sinceDate: Date | undefined,
    includeAlternates: boolean,
  ): Promise<Chapter[]> {
    this.chapterArguments = { ...(sinceDate && { sinceDate }), includeAlternates };
    return [];
  }

  async getChapterDetails(chapter: Chapter): Promise<ChapterDetails> {
    return { id: chapter.chapterId, mangaId: chapter.sourceManga.mangaId, pages: [] };
  }

  async resolvePastedUrl(_query: string): Promise<PagedResults<SearchResultItem> | undefined> {
    return undefined;
  }

  invalidateCaches(): void {
    this.invalidateCalls += 1;
  }
}

describe("Atsumaru extension wiring", () => {
  it("advertises every anonymous manga rail plus live genres", async () => {
    const sections = await new AtsumaruExtension(new FakeClient()).getDiscoverSections();
    assert.deepEqual(
      sections.map(({ id, type }) => ({ id, type })),
      [
        { id: SECTIONS.HOT_UPDATES, type: DiscoverSectionType.featured },
        { id: SECTIONS.RECENTLY_UPDATED, type: DiscoverSectionType.simpleCarousel },
        { id: SECTIONS.POPULAR, type: DiscoverSectionType.featured },
        { id: SECTIONS.RISING, type: DiscoverSectionType.prominentCarousel },
        { id: SECTIONS.HOT_ARRIVALS, type: DiscoverSectionType.prominentCarousel },
        { id: SECTIONS.MOST_BOOKMARKED, type: DiscoverSectionType.simpleCarousel },
        { id: SECTIONS.GENRE_SPOTLIGHT, type: DiscoverSectionType.featured },
        { id: SECTIONS.MOST_TALKED_ABOUT, type: DiscoverSectionType.simpleCarousel },
        { id: SECTIONS.RECENTLY_ADDED, type: DiscoverSectionType.prominentCarousel },
        { id: SECTIONS.BINGE_WORTHY, type: DiscoverSectionType.featured },
        { id: SECTIONS.MOST_POLARIZING, type: DiscoverSectionType.prominentCarousel },
        { id: SECTIONS.HIDDEN_GEMS, type: DiscoverSectionType.featured },
        { id: SECTIONS.TOP_RATED, type: DiscoverSectionType.simpleCarousel },
        { id: SECTIONS.GENRES, type: DiscoverSectionType.genres },
      ],
    );
    assert.deepEqual(
      SORTING_OPTIONS.map(({ id }) => id),
      ["relevance", "title", "most-viewed", "trending", "recently-added", "released", "topRated"],
    );
  });

  it("maps offset-based feed pagination and ignores unknown sections without a request", async () => {
    const client = new FakeClient();
    const extension = new AtsumaruExtension(client);
    const first = await extension.getDiscoverSectionItems(
      { id: SECTIONS.POPULAR, title: "Popular", type: DiscoverSectionType.featured },
      undefined,
    );
    assert.equal(first.items[0]?.type, "featuredCarouselItem");
    assert.deepEqual(first.metadata, { offset: 24 });
    assert.deepEqual(client.homeCalls[0]?.feed, "popular");

    const unknown = await extension.getDiscoverSectionItems(
      { id: "future", title: "Future", type: DiscoverSectionType.simpleCarousel },
      undefined,
    );
    assert.deepEqual(unknown, { items: [] });
    assert.equal(client.homeCalls.length, 1);

    const inherited = await extension.getDiscoverSectionItems(
      { id: "toString", title: "Inherited", type: DiscoverSectionType.simpleCarousel },
      undefined,
    );
    assert.deepEqual(inherited, { items: [] });
    assert.equal(client.homeCalls.length, 1);
  });

  it("returns mutation-isolated sorting options", async () => {
    const extension = new AtsumaruExtension(new FakeClient());
    const first = await extension.getSortingOptions({ title: "" });
    first[0]!.label = "Mutated";
    first.pop();

    const second = await extension.getSortingOptions({ title: "" });
    assert.deepEqual(second, SORTING_OPTIONS);
    assert.notEqual(second, SORTING_OPTIONS);
    assert.notEqual(second[0], SORTING_OPTIONS[0]);
  });

  it("resolves the static spotlight name when the live taxonomy is partial", async () => {
    const client = new FakeClient();
    client.filterOptions.genres.splice(0);
    const extension = new AtsumaruExtension(client);

    await extension.getDiscoverSectionItems(
      {
        id: SECTIONS.GENRE_SPOTLIGHT,
        title: "Genre spotlight",
        type: DiscoverSectionType.featured,
      },
      undefined,
    );

    assert.equal(client.homeCalls[0]?.preferences.genre, "Action");
  });

  it("shares one mutation-isolated filter snapshot across all rails, settings, and search", async () => {
    const client = new FakeClient();
    const extension = new AtsumaruExtension(client);
    const sections = await extension.getDiscoverSections();

    await Promise.all(
      sections.map((section) => extension.getDiscoverSectionItems(section, undefined)),
    );
    await extension.getSettingsForm();
    await extension.getAdvancedSearchForm({ title: "" });

    assert.equal(client.filterCalls, 1);
    assert.equal(client.homeCalls.length, 13);

    client.filterOptions.genres[0]!.name = "Mutated outside extension";
    const genres = await extension.getDiscoverSectionItems(
      { id: SECTIONS.GENRES, title: "Genres", type: DiscoverSectionType.genres },
      undefined,
    );
    assert.equal((genres.items[0] as { name?: string } | undefined)?.name, "Action");
    assert.equal(client.filterCalls, 1);
  });

  it("retries a rejected filter snapshot instead of poisoning later requests", async () => {
    const client = new FakeClient();
    client.filterFailure = new Error("temporary filter outage");
    const extension = new AtsumaruExtension(client);
    const section = { id: SECTIONS.GENRES, title: "Genres", type: DiscoverSectionType.genres };

    const first = extension.getDiscoverSectionItems(section, undefined);
    const second = extension.getDiscoverSectionItems(section, undefined);
    await Promise.all([
      assert.rejects(first, /temporary filter outage/),
      assert.rejects(second, /temporary filter outage/),
    ]);
    assert.equal(client.filterCalls, 1);

    const result = await extension.getDiscoverSectionItems(section, undefined);

    assert.equal((result.items[0] as { name?: string } | undefined)?.name, "Action");
    assert.equal(client.filterCalls, 2);
  });

  it("drops the filter snapshot when Cloudflare invalidates client caches", async () => {
    const client = new FakeClient();
    const extension = new AtsumaruExtension(client);
    const section = { id: SECTIONS.GENRES, title: "Genres", type: DiscoverSectionType.genres };

    await extension.getDiscoverSectionItems(section, undefined);
    await extension.getDiscoverSectionItems(section, undefined);
    assert.equal(client.filterCalls, 1);
    await extension.cloudflareBypassCompleted({} as Request, [], {});
    await extension.getDiscoverSectionItems(section, undefined);

    assert.equal(client.invalidateCalls, 1);
    assert.equal(client.filterCalls, 2);
  });

  it("turns live genres into exact tri-state searches", async () => {
    const extension = new AtsumaruExtension(new FakeClient());
    const result = await extension.getDiscoverSectionItems(
      { id: SECTIONS.GENRES, title: "Genres", type: DiscoverSectionType.genres },
      undefined,
    );
    assert.deepEqual(result.items[0], {
      type: "genresCarouselItem",
      name: "Action",
      searchQuery: { title: "", metadata: { genres: { "39": "included" } } },
      contentRating: ContentRating.EVERYONE,
    });
    assert.equal(result.items[1]?.contentRating, ContentRating.ADULT);
    assert.deepEqual(result.items[1], {
      type: "genresCarouselItem",
      name: "Adult",
      searchQuery: {
        title: "",
        metadata: { genres: { "46": "included" }, adult: "adult" },
      },
      contentRating: ContentRating.ADULT,
    });
  });

  it("forwards search metadata/sort/page and emits the next one-based page", async () => {
    const client = new FakeClient();
    const extension = new AtsumaruExtension(client);
    const query: SearchQuery<AtsumaruSearchMetadata> = {
      title: "pick me up",
      metadata: { genres: { "39": "included" }, adult: "safe" },
    };
    const result = await extension.getSearchResults(
      query,
      { page: 1 },
      { id: "topRated", label: "Top rated" },
    );
    assert.deepEqual(result.metadata, { page: 2 });
    assert.deepEqual(client.searchCalls[0], {
      query,
      sorting: { id: "topRated", label: "Top rated" },
      page: 1,
    });
    assert.equal(result.items[0]?.subtitle, "★ 8.4 · 6.7M views · 213 chapters");
  });

  it("keeps alternate scanlations enabled for archive compatibility by default", async () => {
    const client = new FakeClient();
    const extension = new AtsumaruExtension(client);
    const source = await client.getMangaDetails("oJQ4o");
    const sinceDate = new Date("2026-08-01T00:00:00Z");
    await extension.getChapters(source, sinceDate);
    assert.deepEqual(client.chapterArguments, { sinceDate, includeAlternates: true });
  });
});
