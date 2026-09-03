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
  type Tag,
} from "@paperback/types";

import {
  RinkoComicsExtension,
  SECTIONS,
  SORTING_OPTIONS,
  type RinkoComicsClientContract,
} from "./main.js";
import type { RinkoCatalogItem, RinkoCatalogPage, RinkoSearchMetadata } from "./models.js";
import { RinkoComicsAdvancedSearchForm } from "./search.js";

const originalApplication = globalThis.Application;

beforeEach(() => {
  Object.assign(globalThis, {
    Application: {
      Selector: (_base: unknown, method: string) => method,
    },
  });
});

afterEach(() => Object.assign(globalThis, { Application: originalApplication }));

const item = (overrides: Partial<RinkoCatalogItem> = {}): RinkoCatalogItem => ({
  mangaId: "fixture-flower-path@900",
  slug: "fixture-flower-path",
  postId: "900",
  title: "Fixture Flower Path",
  imageUrl: "https://rinkocomics.com/wp-content/uploads/cover.webp",
  genres: ["Action", "Romance"],
  contentRating: ContentRating.MATURE,
  ...overrides,
});

const manga: SourceManga = {
  mangaId: "fixture-flower-path@900",
  mangaInfo: {
    primaryTitle: "Fixture Flower Path",
    secondaryTitles: [],
    thumbnailUrl: "https://rinkocomics.com/wp-content/uploads/cover.webp",
    synopsis: "Fixture",
    contentRating: ContentRating.MATURE,
  },
};

class FakeClient implements RinkoComicsClientContract {
  calls: {
    query: SearchQuery<RinkoSearchMetadata>;
    sortingOption: SortingOption | undefined;
    page: number;
  }[] = [];
  pastedResult: PagedResults<SearchResultItem> | undefined;

  async getCatalogPage(
    query: SearchQuery<RinkoSearchMetadata>,
    sortingOption: SortingOption | undefined,
    page: number,
  ): Promise<RinkoCatalogPage> {
    this.calls.push({ query, sortingOption, page });
    return { items: [item()], page, hasNextPage: page === 1 };
  }

  async getGenres(): Promise<Tag[]> {
    return [
      { id: "action", title: "Action" },
      { id: "romance", title: "Romance" },
    ];
  }

  async getMangaDetails(mangaId: string): Promise<SourceManga> {
    return { ...manga, mangaId };
  }

  async getChapters(sourceManga: SourceManga, _sinceDate?: Date): Promise<Chapter[]> {
    return [{ chapterId: "chapter-1@1", sourceManga, langCode: "en", chapNum: 1 }];
  }

  async getChapterDetails(chapter: Chapter): Promise<ChapterDetails> {
    return { id: chapter.chapterId, mangaId: chapter.sourceManga.mangaId, pages: [] };
  }

  async resolvePastedUrl(_value: string): Promise<PagedResults<SearchResultItem> | undefined> {
    return this.pastedResult;
  }

  invalidateCaches(): void {}
}

describe("Rinko Comics extension", () => {
  it("exposes the complete public discovery and sorting surface", async () => {
    const extension = new RinkoComicsExtension(new FakeClient());
    assert.deepEqual(
      (await extension.getDiscoverSections()).map(({ id, type }) => ({ id, type })),
      [
        { id: SECTIONS.LATEST, type: DiscoverSectionType.prominentCarousel },
        { id: SECTIONS.GENRES, type: DiscoverSectionType.genres },
      ],
    );
    assert.deepEqual(
      (await extension.getSortingOptions({ title: "" })).map((option) => option.id),
      ["newest", "oldest", "az", "za"],
    );
    assert.notEqual(await extension.getSortingOptions({ title: "" }), SORTING_OPTIONS);
  });

  it("maps latest discovery and preserves pagination metadata", async () => {
    const client = new FakeClient();
    const extension = new RinkoComicsExtension(client);
    const result = await extension.getDiscoverSectionItems(
      {
        id: SECTIONS.LATEST,
        title: "Newest series",
        type: DiscoverSectionType.prominentCarousel,
      },
      undefined,
    );
    assert.deepEqual(result.items[0], {
      type: "prominentCarouselItem",
      mangaId: "fixture-flower-path@900",
      title: "Fixture Flower Path",
      imageUrl: "https://rinkocomics.com/wp-content/uploads/cover.webp",
      subtitle: "Action • Romance",
      contentRating: ContentRating.MATURE,
    });
    assert.deepEqual(result.metadata, { page: 2 });
    assert.deepEqual(client.calls[0], {
      query: { title: "" },
      sortingOption: { id: "newest", label: "Newest" },
      page: 1,
    });
  });

  it("turns genres into exact searches with conservative ratings", async () => {
    const extension = new RinkoComicsExtension(new FakeClient());
    const result = await extension.getDiscoverSectionItems(
      { id: SECTIONS.GENRES, title: "Genres", type: DiscoverSectionType.genres },
      undefined,
    );
    assert.deepEqual(result.items[0], {
      type: "genresCarouselItem",
      name: "Action",
      searchQuery: { title: "", metadata: { genres: ["action"] } },
      contentRating: ContentRating.MATURE,
    });
    assert.deepEqual(
      await extension.getDiscoverSectionItems(
        { id: SECTIONS.GENRES, title: "Genres", type: DiscoverSectionType.genres },
        { page: 2 },
      ),
      { items: [] },
    );
  });

  it("forwards title, filters, sorting, and pages into search", async () => {
    const client = new FakeClient();
    const extension = new RinkoComicsExtension(client);
    const query: SearchQuery<RinkoSearchMetadata> = {
      title: "flower",
      metadata: { genres: ["romance"] },
    };
    const result = await extension.getSearchResults(
      query,
      { page: 3 },
      { id: "az", label: "Title: A–Z" },
    );
    assert.equal(result.items[0]?.mangaId, "fixture-flower-path@900");
    assert.deepEqual(result.metadata, undefined);
    assert.deepEqual(client.calls[0], {
      query,
      sortingOption: { id: "az", label: "Title: A–Z" },
      page: 3,
    });
  });

  it("rejects malformed runtime page metadata and hostile section objects safely", async () => {
    const extension = new RinkoComicsExtension(new FakeClient());
    for (const metadata of [
      { page: 0 },
      { page: 501 },
      { page: 1, token: "secret" },
      Object.create({ page: 1 }),
      Object.defineProperty({}, "page", { value: 1, enumerable: false }),
      Object.defineProperty({}, "token", { value: "secret", enumerable: false }),
      new Proxy(
        {},
        {
          ownKeys() {
            throw new Error("secret-token");
          },
        },
      ),
    ]) {
      await assert.rejects(
        extension.getSearchResults({ title: "" }, metadata as { page: number }),
        (error: unknown) =>
          error instanceof Error &&
          error.message === "Rinko Comics page metadata is invalid." &&
          !("cause" in error),
      );
    }
    const hostileSection = Object.defineProperty({}, "id", {
      enumerable: true,
      get() {
        throw new Error("secret-token");
      },
    });
    await assert.rejects(
      extension.getDiscoverSectionItems(
        hostileSection as Parameters<RinkoComicsExtension["getDiscoverSectionItems"]>[0],
        undefined,
      ),
      /discovery section is invalid/i,
    );
    await assert.rejects(
      extension.getSortingOptions(Object.create({ title: "" }) as SearchQuery<RinkoSearchMetadata>),
      /search query is invalid/i,
    );
    await assert.rejects(
      extension.getAdvancedSearchForm(
        new Proxy({} as SearchQuery<RinkoSearchMetadata>, {
          ownKeys() {
            throw new Error("secret-token");
          },
        }),
      ),
      /search query is invalid/i,
    );
  });

  it("returns recognized pasted URLs without issuing a catalog search", async () => {
    const client = new FakeClient();
    client.pastedResult = {
      items: [
        {
          mangaId: manga.mangaId,
          title: "Fixture Flower Path",
          imageUrl: manga.mangaInfo.thumbnailUrl,
          contentRating: ContentRating.MATURE,
        },
      ],
    };
    const extension = new RinkoComicsExtension(client);
    const result = await extension.getSearchResults(
      { title: "https://rinkocomics.com/comic/fixture-flower-path/" },
      undefined,
    );
    assert.equal(result.items[0]?.mangaId, manga.mangaId);
    assert.equal(client.calls.length, 0);
    await assert.rejects(
      extension.getSearchResults(
        { title: "https://rinkocomics.com/comic/fixture-flower-path/" },
        undefined,
        { id: "newest", label: "Newest", token: "secret" } as SortingOption,
      ),
      /sorting option is invalid/i,
    );
  });

  it("builds a multi-genre advanced-search form from live options", async () => {
    const extension = new RinkoComicsExtension(new FakeClient());
    const form = await extension.getAdvancedSearchForm({
      title: "",
      metadata: { genres: ["romance"] },
    });
    assert.ok(form instanceof RinkoComicsAdvancedSearchForm);
    assert.deepEqual(form.getSearchQueryMetadata(), { genres: ["romance"] });
    const sections = form.getSections();
    assert.equal(sections.length, 1);
    await assert.rejects(
      form.handleGenresChange(["action", "action"]),
      /genre filters are invalid/i,
    );
    await assert.rejects(
      extension.getAdvancedSearchForm({ title: "", metadata: { genres: ["invalid"] } }),
      /genre filters are invalid/i,
    );
  });
});
