import {
  BasicRateLimiter,
  ContentRating,
  DiscoverSectionType,
  type AdvancedSearchForm,
  type Chapter,
  type ChapterDetails,
  type DiscoverSection,
  type DiscoverSectionItem,
  type ExtensionImpl,
  type PagedResults,
  type SearchQuery,
  type SearchResultItem,
  type SortingOption,
  type SourceManga,
  type Tag,
} from "@paperback/types";

import { RinkoComicsClient } from "./client.js";
import { RinkoComicsInterceptor } from "./interceptor.js";
import type {
  RinkoCatalogItem,
  RinkoCatalogPage,
  RinkoPageMetadata,
  RinkoSearchMetadata,
} from "./models.js";
import { MAX_CATALOG_PAGES, normalizeRinkoSearchQuery, rinkoSortId } from "./network.js";
import type RinkoComicsConfig from "./pbconfig.js";
import { RinkoComicsAdvancedSearchForm } from "./search.js";

export interface RinkoComicsClientContract {
  getCatalogPage(
    query: SearchQuery<RinkoSearchMetadata>,
    sortingOption: SortingOption | undefined,
    page: number,
  ): Promise<RinkoCatalogPage>;
  getGenres(): Promise<Tag[]>;
  getMangaDetails(mangaId: string): Promise<SourceManga>;
  getChapters(sourceManga: SourceManga, sinceDate?: Date): Promise<Chapter[]>;
  getChapterDetails(chapter: Chapter): Promise<ChapterDetails>;
  resolvePastedUrl(value: string): Promise<PagedResults<SearchResultItem> | undefined>;
  invalidateCaches(): void;
}

export const SECTIONS = {
  LATEST: "latest",
  GENRES: "genres",
} as const;

export const SORTING_OPTIONS: SortingOption[] = [
  { id: "newest", label: "Newest" },
  { id: "oldest", label: "Oldest" },
  { id: "az", label: "Title: A–Z" },
  { id: "za", label: "Title: Z–A" },
];

const searchItem = (item: RinkoCatalogItem): SearchResultItem => ({
  mangaId: item.mangaId,
  title: item.title,
  imageUrl: item.imageUrl,
  ...(item.genres.length > 0 && { subtitle: item.genres.join(" • ") }),
  contentRating: item.contentRating,
});

const nextPage = (page: RinkoCatalogPage): RinkoPageMetadata | undefined =>
  page.hasNextPage ? { page: page.page + 1 } : undefined;

const sectionId = (value: unknown): string | undefined => {
  try {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      !Object.prototype.hasOwnProperty.call(value, "id")
    ) {
      return undefined;
    }
    const id = (value as Record<string, unknown>)["id"];
    return typeof id === "string" ? id : undefined;
  } catch {
    throw new Error("Rinko Comics discovery section is invalid.");
  }
};

const pageFromMetadata = (value: unknown): number => {
  if (value === undefined) return 1;
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("invalid");
    }
    const ownKeys = Reflect.ownKeys(value);
    let enumerableCount = 0;
    for (const key in value) {
      if (
        !Object.prototype.hasOwnProperty.call(value, key) ||
        key !== "page" ||
        ++enumerableCount > 1
      ) {
        throw new Error("invalid");
      }
    }
    if (ownKeys.length === 0) return 1;
    if (
      ownKeys.length !== 1 ||
      ownKeys[0] !== "page" ||
      enumerableCount !== 1 ||
      !Object.prototype.propertyIsEnumerable.call(value, "page")
    ) {
      throw new Error("invalid");
    }
    const page = (value as Record<string, unknown>)["page"];
    if (
      typeof page !== "number" ||
      !Number.isSafeInteger(page) ||
      page < 1 ||
      page > MAX_CATALOG_PAGES
    ) {
      throw new Error("invalid");
    }
    return page;
  } catch {
    throw new Error("Rinko Comics page metadata is invalid.");
  }
};

export class RinkoComicsExtension implements ExtensionImpl<typeof RinkoComicsConfig> {
  private readonly rateLimiter = new BasicRateLimiter("rinkoComicsRateLimiter", {
    numberOfRequests: 3,
    bufferInterval: 1,
    ignoreImages: true,
  });
  private readonly interceptor = new RinkoComicsInterceptor();
  private readonly client: RinkoComicsClientContract;

  constructor(client: RinkoComicsClientContract = new RinkoComicsClient()) {
    this.client = client;
  }

  async initialise(): Promise<void> {
    this.rateLimiter.registerInterceptor();
    this.interceptor.registerInterceptor();
  }

  async getDiscoverSections(): Promise<DiscoverSection[]> {
    return [
      {
        id: SECTIONS.LATEST,
        title: "Newest series",
        type: DiscoverSectionType.prominentCarousel,
      },
      { id: SECTIONS.GENRES, title: "Genres", type: DiscoverSectionType.genres },
    ];
  }

  async getDiscoverSectionItems(
    section: DiscoverSection,
    metadata: RinkoPageMetadata | undefined,
  ): Promise<PagedResults<DiscoverSectionItem>> {
    const pageNumber = pageFromMetadata(metadata);
    const id = sectionId(section);
    if (id === SECTIONS.GENRES) {
      if (pageNumber !== 1) return { items: [] };
      return {
        items: (await this.client.getGenres()).map((genre) => ({
          type: "genresCarouselItem",
          name: genre.title,
          searchQuery: {
            title: "",
            metadata: { genres: [genre.id] } satisfies RinkoSearchMetadata,
          },
          contentRating: ContentRating.MATURE,
        })),
      };
    }
    if (id !== SECTIONS.LATEST) return { items: [] };
    const page = await this.client.getCatalogPage({ title: "" }, SORTING_OPTIONS[0], pageNumber);
    return {
      items: page.items.map((item) => ({
        type: "prominentCarouselItem",
        mangaId: item.mangaId,
        title: item.title,
        imageUrl: item.imageUrl,
        ...(item.genres.length > 0 && { subtitle: item.genres.join(" • ") }),
        contentRating: item.contentRating,
      })),
      metadata: nextPage(page),
    };
  }

  async getSortingOptions(query: SearchQuery<RinkoSearchMetadata>): Promise<SortingOption[]> {
    normalizeRinkoSearchQuery(query);
    return SORTING_OPTIONS.map((option) => ({ ...option }));
  }

  async getAdvancedSearchForm(
    query: SearchQuery<RinkoSearchMetadata>,
  ): Promise<AdvancedSearchForm> {
    return new RinkoComicsAdvancedSearchForm(
      normalizeRinkoSearchQuery(query),
      await this.client.getGenres(),
    );
  }

  async getSearchResults(
    query: SearchQuery<RinkoSearchMetadata>,
    metadata: RinkoPageMetadata | undefined,
    sortingOption?: SortingOption,
  ): Promise<PagedResults<SearchResultItem>> {
    const normalizedQuery = normalizeRinkoSearchQuery(query);
    const pageNumber = pageFromMetadata(metadata);
    rinkoSortId(sortingOption);
    const pasted = await this.client.resolvePastedUrl(normalizedQuery.title);
    if (pasted) return pasted;
    const page = await this.client.getCatalogPage(normalizedQuery, sortingOption, pageNumber);
    return { items: page.items.map(searchItem), metadata: nextPage(page) };
  }

  async getMangaDetails(mangaId: string): Promise<SourceManga> {
    return this.client.getMangaDetails(mangaId);
  }

  async getChapters(sourceManga: SourceManga, sinceDate?: Date): Promise<Chapter[]> {
    return this.client.getChapters(sourceManga, sinceDate);
  }

  async getChapterDetails(chapter: Chapter): Promise<ChapterDetails> {
    return this.client.getChapterDetails(chapter);
  }
}

export const RinkoComics = new RinkoComicsExtension();
