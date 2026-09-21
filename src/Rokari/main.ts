import {
  BasicRateLimiter,
  DiscoverSectionType,
  type AdvancedSearchForm,
  type Chapter,
  type ChapterDetails,
  type Cookie,
  type DiscoverSection,
  type DiscoverSectionItem,
  type ExtensionImpl,
  type Form,
  type PagedResults,
  type Request,
  type SearchQuery,
  type SearchResultItem,
  type SortingOption,
  type SourceManga,
} from "@paperback/types";

import { contentRatingForTags } from "../shared/html.js";
import { RokariClient } from "./client.js";
import { RokariCookieInterceptor } from "./cookies.js";
import { RokariInterceptor } from "./interceptor.js";
import type { RokariCatalogPage, RokariPageMetadata, RokariSearchMetadata } from "./models.js";
import type RokariConfig from "./pbconfig.js";
import { RokariAdvancedSearchForm } from "./search.js";
import { RokariSettingsForm } from "./settings.js";

export interface RokariClientContract {
  getCatalogPage(order?: "update" | "popular"): Promise<RokariCatalogPage>;
  searchComics(term: string): Promise<RokariCatalogPage>;
  getFilterOptions(): Promise<{ genres: { id: string; title: string }[] }>;
  getMangaDetails(mangaId: string): Promise<SourceManga>;
  getChapters(sourceManga: SourceManga, sinceDate?: Date): Promise<Chapter[]>;
  getChapterDetails(chapter: Chapter): Promise<ChapterDetails>;
  getDetailsAndChapters(
    mangaId: string,
    sinceDate?: Date,
  ): Promise<{ manga: SourceManga; chapters: Chapter[] }>;
  resolvePastedUrl(query: string): Promise<PagedResults<SearchResultItem> | undefined>;
  invalidateCaches(): void;
}

export const SECTIONS = {
  LATEST: "latest",
  POPULAR: "popular",
  GENRES: "genres",
} as const;

export const SORTING_OPTIONS: SortingOption[] = [
  { id: "update", label: "Recently updated" },
  { id: "popular", label: "Popular" },
];

const searchItems = (page: RokariCatalogPage): SearchResultItem[] =>
  page.items.map((item) => ({
    mangaId: item.mangaId,
    title: item.title,
    imageUrl: item.imageUrl,
    subtitle: item.latestChapter,
    contentRating: item.contentRating,
  }));

const sectionItems = (page: RokariCatalogPage): DiscoverSectionItem[] =>
  page.items.map((item) => ({
    type: "simpleCarouselItem",
    mangaId: item.mangaId,
    title: item.title,
    imageUrl: item.imageUrl,
    subtitle: item.latestChapter,
    contentRating: item.contentRating,
  }));

export class RokariExtension implements ExtensionImpl<typeof RokariConfig> {
  private readonly rateLimiter = new BasicRateLimiter("rokariRateLimiter", {
    numberOfRequests: 6,
    bufferInterval: 1,
    ignoreImages: true,
  });
  private readonly cookies = new RokariCookieInterceptor();
  private readonly interceptor = new RokariInterceptor();

  constructor(private readonly client: RokariClientContract = new RokariClient()) {}

  async initialise(): Promise<void> {
    this.rateLimiter.registerInterceptor();
    this.cookies.registerInterceptor();
    this.interceptor.registerInterceptor();
  }

  async getSettingsForm(): Promise<Form> {
    return new RokariSettingsForm();
  }

  async cloudflareBypassCompleted(
    _request: Request,
    cookies: Cookie[],
    _localStorage: Record<string, string>,
  ): Promise<void> {
    for (const cookie of cookies) this.cookies.setCookie(cookie);
    this.client.invalidateCaches();
  }

  async getDiscoverSections(): Promise<DiscoverSection[]> {
    return [
      { id: SECTIONS.LATEST, title: "Latest updates", type: DiscoverSectionType.simpleCarousel },
      { id: SECTIONS.POPULAR, title: "Popular", type: DiscoverSectionType.simpleCarousel },
      { id: SECTIONS.GENRES, title: "Genres", type: DiscoverSectionType.genres },
    ];
  }

  async getDiscoverSectionItems(
    section: DiscoverSection,
    metadata: RokariPageMetadata | undefined,
  ): Promise<PagedResults<DiscoverSectionItem>> {
    if (section.id === SECTIONS.GENRES) {
      return {
        items: (await this.client.getFilterOptions()).genres.map((genre) => ({
          type: "genresCarouselItem",
          name: genre.title,
          searchQuery: {
            title: "",
            metadata: { genres: [genre.id] } satisfies RokariSearchMetadata,
          },
          contentRating: contentRatingForTags([genre.title]),
        })),
      };
    }
    if (section.id !== SECTIONS.LATEST && section.id !== SECTIONS.POPULAR) return { items: [] };
    if ((metadata?.page ?? 1) > 1) return { items: [] };
    const page = await this.client.getCatalogPage(
      section.id === SECTIONS.POPULAR ? "popular" : "update",
    );
    return { items: sectionItems(page) };
  }

  async getSortingOptions(_query: SearchQuery<RokariSearchMetadata>): Promise<SortingOption[]> {
    return SORTING_OPTIONS;
  }

  async getAdvancedSearchForm(
    query: SearchQuery<RokariSearchMetadata>,
  ): Promise<AdvancedSearchForm> {
    return new RokariAdvancedSearchForm(query, (await this.client.getFilterOptions()).genres);
  }

  async getSearchResults(
    query: SearchQuery<RokariSearchMetadata>,
    metadata: RokariPageMetadata | undefined,
    _sortingOption?: SortingOption,
  ): Promise<PagedResults<SearchResultItem>> {
    const pasted = await this.client.resolvePastedUrl(query.title ?? "");
    if (pasted) return pasted;
    const term = query.title?.trim() ?? "";
    if ((metadata?.page ?? 1) > 1) return { items: [] };
    if (!term) {
      return { items: searchItems(await this.client.getCatalogPage("update")) };
    }
    return { items: searchItems(await this.client.searchComics(term)) };
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

export const Rokari = new RokariExtension();
