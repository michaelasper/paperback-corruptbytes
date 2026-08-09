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

import {
  MadaraDexExtension,
  SECTIONS,
  SORTING_OPTIONS,
  type MadaraDexClientContract,
} from "./main.js";
import type {
  MadaraCard,
  MadaraCatalogPage,
  MadaraFilterOptions,
  MadaraSearchMetadata,
} from "./models.js";

const originalApplication = globalThis.Application;
let state: Map<string, unknown>;

beforeEach(() => {
  state = new Map();
  Object.assign(globalThis, {
    Application: {
      Selector: (_form: unknown, method: string) => method,
      getSecureState: (key: string) => state.get(key),
      setSecureState: (value: unknown, key: string) => state.set(key, value),
    },
  });
});

afterEach(() => Object.assign(globalThis, { Application: originalApplication }));

const card = (overrides: Partial<MadaraCard> = {}): MadaraCard => ({
  mangaId: "574",
  title: "Magic Emperor",
  imageUrl: "https://madaradex.org/wp-content/uploads/574.webp",
  contentRating: ContentRating.MATURE,
  rating: 0.8,
  latestChapterId: "chapter-894",
  latestChapterTitle: "Chapter 894",
  ...overrides,
});

class FakeClient implements MadaraDexClientContract {
  calls: {
    query: SearchQuery<MadaraSearchMetadata>;
    sort?: SortingOption;
    page: number;
  }[] = [];

  async getCatalogPage(
    query: SearchQuery<MadaraSearchMetadata>,
    sort: SortingOption | undefined,
    page: number,
  ): Promise<MadaraCatalogPage> {
    this.calls.push({ query, sort, page });
    return { items: [card()], hasNextPage: page < 2 };
  }

  async getFilterOptions(): Promise<MadaraFilterOptions> {
    return {
      genres: [{ id: "action", title: "Action" }],
      statuses: [{ id: "on-going", title: "Ongoing" }],
    };
  }

  async getMangaDetails(mangaId: string): Promise<SourceManga> {
    return {
      mangaId,
      mangaInfo: {
        primaryTitle: "Magic Emperor",
        secondaryTitles: [],
        thumbnailUrl: "https://madaradex.org/wp-content/uploads/574.webp",
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

describe("MadaraDex extension", () => {
  it("exposes every useful live sort and a complete six-section discovery surface", async () => {
    const extension = new MadaraDexExtension(new FakeClient());
    assert.deepEqual(
      (await extension.getDiscoverSections()).map(({ id, type }) => ({ id, type })),
      [
        { id: SECTIONS.NEW_SERIES, type: DiscoverSectionType.featured },
        { id: SECTIONS.RECENT_UPDATES, type: DiscoverSectionType.chapterUpdates },
        { id: SECTIONS.TRENDING, type: DiscoverSectionType.prominentCarousel },
        { id: SECTIONS.MOST_VIEWED, type: DiscoverSectionType.featured },
        { id: SECTIONS.TOP_RATED, type: DiscoverSectionType.simpleCarousel },
        { id: SECTIONS.GENRES, type: DiscoverSectionType.genres },
      ],
    );
    assert.deepEqual(
      SORTING_OPTIONS.map(({ id }) => id),
      ["relevance", "latest", "alphabet", "rating", "trending", "views", "new-manga"],
    );
  });

  it("maps latest entries to chapter-update items and paginates only when the site can continue", async () => {
    const client = new FakeClient();
    const extension = new MadaraDexExtension(client);
    const first = await extension.getDiscoverSectionItems(
      {
        id: SECTIONS.RECENT_UPDATES,
        title: "Recently updated",
        type: DiscoverSectionType.chapterUpdates,
      },
      undefined,
    );
    const last = await extension.getDiscoverSectionItems(
      { id: SECTIONS.TOP_RATED, title: "Top rated", type: DiscoverSectionType.simpleCarousel },
      { page: 2 },
    );
    assert.deepEqual(first.items[0], {
      type: "chapterUpdatesCarouselItem",
      mangaId: "574",
      chapterId: "chapter-894",
      imageUrl: "https://madaradex.org/wp-content/uploads/574.webp",
      title: "Magic Emperor",
      subtitle: "Chapter 894",
      contentRating: ContentRating.MATURE,
    });
    assert.deepEqual(first.metadata, { page: 2 });
    assert.equal(last.metadata, undefined);
    assert.equal(client.calls[0]?.sort?.id, "latest");
  });

  it("turns genres into valid searches and forwards all advanced search state", async () => {
    const client = new FakeClient();
    const extension = new MadaraDexExtension(client);
    const genres = await extension.getDiscoverSectionItems(
      { id: SECTIONS.GENRES, title: "Genres", type: DiscoverSectionType.genres },
      undefined,
    );
    assert.deepEqual(genres.items[0], {
      type: "genresCarouselItem",
      name: "Action",
      searchQuery: { title: "", metadata: { genres: ["action"] } },
      contentRating: ContentRating.EVERYONE,
    });

    const query: SearchQuery<MadaraSearchMetadata> = {
      title: "magic",
      metadata: { genres: ["action"], adult: "none", status: ["on-going"] },
    };
    const result = await extension.getSearchResults(
      query,
      { page: 2 },
      { id: "rating", label: "Rating" },
    );
    assert.equal(result.items[0]?.mangaId, "574");
    assert.equal(result.metadata, undefined);
    assert.deepEqual(client.calls.at(-1), {
      query,
      sort: { id: "rating", label: "Rating" },
      page: 2,
    });
  });
});
