import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  ContentRating,
  DiscoverSectionType,
  type Chapter,
  type ChapterDetails,
  type PagedResults,
  type SearchQuery,
  type SearchResultItem,
  type SortingOption,
  type SourceManga,
} from "@paperback/types";

import { MgekoExtension, SECTIONS, type MgekoClientContract } from "./main.js";
import type {
  MgekoBrowseEnvelope,
  MgekoCard,
  MgekoFilterOptions,
  MgekoSearchMetadata,
} from "./models.js";

const originalApplication = globalThis.Application;
let state = new Map<string, unknown>();

beforeEach(() => {
  state = new Map();
  Object.assign(globalThis, {
    Application: {
      Selector: (_form: unknown, method: string) => method,
      getState: (key: string) => state.get(key),
      setState: (value: unknown, key: string) => state.set(key, value),
      getSecureState: (key: string) => state.get(`secure:${key}`),
      setSecureState: (value: unknown, key: string) => state.set(`secure:${key}`, value),
    },
  });
});

afterEach(() => Object.assign(globalThis, { Application: originalApplication }));

const card = (overrides: Partial<MgekoCard> = {}): MgekoCard => ({
  mangaId: "dark-mage",
  title: "Dark Mage",
  imageUrl: "https://imgsrv5.com/dark.webp",
  contentRating: ContentRating.MATURE,
  rating: 0.9,
  views: 12_345,
  badge: "Trending",
  ...overrides,
});

class FakeClient implements MgekoClientContract {
  calls: {
    query: SearchQuery<MgekoSearchMetadata>;
    sort?: SortingOption;
    page: number;
    safe: boolean;
  }[] = [];

  async getBrowsePage(
    query: SearchQuery<MgekoSearchMetadata>,
    sort: SortingOption | undefined,
    page: number,
    safe: boolean,
  ): Promise<MgekoBrowseEnvelope & { items: MgekoCard[] }> {
    this.calls.push({ query, sort, page, safe });
    return { resultsHtml: "", page, pageCount: 2, totalCount: 30, items: [card()] };
  }

  async getFilterOptions(): Promise<MgekoFilterOptions> {
    return {
      genres: [{ id: "Action", title: "Action" }],
      statuses: [],
      types: [],
    };
  }

  async getMangaDetails(mangaId: string): Promise<SourceManga> {
    return {
      mangaId,
      mangaInfo: {
        primaryTitle: "Dark Mage",
        secondaryTitles: [],
        thumbnailUrl: "https://imgsrv5.com/dark.webp",
        synopsis: "",
        contentRating: ContentRating.MATURE,
      },
    };
  }

  async getChapters(_sourceManga: SourceManga, _sinceDate?: Date): Promise<Chapter[]> {
    return [];
  }

  async getChapterDetails(chapter: Chapter): Promise<ChapterDetails> {
    return { id: chapter.chapterId, mangaId: chapter.sourceManga.mangaId, pages: [] };
  }

  async resolvePastedUrl(_query: string): Promise<PagedResults<SearchResultItem> | undefined> {
    return undefined;
  }

  invalidateCaches(): void {}
}

describe("Mgeko extension", () => {
  it("enables the complete discovery surface with accurate section types", async () => {
    const sections = await new MgekoExtension(new FakeClient()).getDiscoverSections();
    assert.deepEqual(
      sections.map(({ id, type }) => ({ id, type })),
      [
        { id: SECTIONS.POPULAR_ALL_TIME, type: DiscoverSectionType.featured },
        { id: SECTIONS.TOP_RATED, type: DiscoverSectionType.prominentCarousel },
        { id: SECTIONS.LATEST, type: DiscoverSectionType.simpleCarousel },
        { id: SECTIONS.RECENTLY_ADDED, type: DiscoverSectionType.prominentCarousel },
        { id: SECTIONS.POPULAR_DAILY, type: DiscoverSectionType.simpleCarousel },
        { id: SECTIONS.GENRES, type: DiscoverSectionType.genres },
      ],
    );
  });

  it("maps discovery cards and stops exactly at the server page count", async () => {
    const client = new FakeClient();
    const extension = new MgekoExtension(client);
    const first = await extension.getDiscoverSectionItems(
      { id: SECTIONS.POPULAR_ALL_TIME, title: "Popular", type: DiscoverSectionType.featured },
      undefined,
    );
    const last = await extension.getDiscoverSectionItems(
      { id: SECTIONS.LATEST, title: "Latest", type: DiscoverSectionType.simpleCarousel },
      { page: 2 },
    );

    assert.equal(first.items[0]?.type, "featuredCarouselItem");
    assert.deepEqual(first.metadata, { page: 2 });
    assert.equal(last.metadata, undefined);
    assert.equal(client.calls[0]?.sort?.id, "popular_all_time");
  });

  it("uses the browse API for title searches, all filters, pagination, and safe mode", async () => {
    const client = new FakeClient();
    const extension = new MgekoExtension(client);
    const query: SearchQuery<MgekoSearchMetadata> = {
      title: "dark mage",
      metadata: { genres: { Action: "included" }, minRating: 4 },
    };

    state.set("safe_mode", false);
    const result = await extension.getSearchResults(
      query,
      { page: 2 },
      { id: "latest", label: "Recently updated" },
    );
    assert.equal(result.items[0]?.mangaId, "dark-mage");
    assert.equal(result.metadata, undefined);
    assert.deepEqual(client.calls[0], {
      query,
      sort: { id: "latest", label: "Recently updated" },
      page: 2,
      safe: false,
    });
  });

  it("turns genres into working searches", async () => {
    const extension = new MgekoExtension(new FakeClient());
    const result = await extension.getDiscoverSectionItems(
      { id: SECTIONS.GENRES, title: "Genres", type: DiscoverSectionType.genres },
      undefined,
    );
    assert.deepEqual(result.items[0], {
      type: "genresCarouselItem",
      name: "Action",
      searchQuery: { title: "", metadata: { genres: { Action: "included" } } },
      contentRating: ContentRating.EVERYONE,
    });
  });
});
