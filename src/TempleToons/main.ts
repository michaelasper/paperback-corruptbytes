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

import { TempleClient } from "./client.js";
import { TempleCookieInterceptor } from "./cookies.js";
import { TempleInterceptor } from "./interceptor.js";
import type { TempleCatalogPage, TemplePageMetadata, TempleSearchMetadata } from "./models.js";
import type TempleConfig from "./pbconfig.js";
import { TempleAdvancedSearchForm } from "./search.js";
import { TempleSettingsForm } from "./settings.js";

export interface TempleClientContract {
  getCatalogPage(page: number): Promise<TempleCatalogPage>;
  searchComics(term: string, page: number): Promise<TempleCatalogPage>;
  getMangaDetails(mangaId: string): Promise<SourceManga>;
  getChapters(sourceManga: SourceManga, sinceDate?: Date): Promise<Chapter[]>;
  getChapterDetails(chapter: Chapter): Promise<ChapterDetails>;
  resolvePastedUrl(query: string): Promise<PagedResults<SearchResultItem> | undefined>;
  invalidateCaches(): void;
}

export const SECTIONS = {
  LATEST: "latest",
} as const;

const searchItems = (page: TempleCatalogPage): SearchResultItem[] =>
  page.items.map((item) => ({
    mangaId: item.mangaId,
    title: item.title,
    imageUrl: item.imageUrl,
    subtitle: item.subtitle,
    contentRating: item.contentRating,
  }));

const sectionItems = (page: TempleCatalogPage): DiscoverSectionItem[] =>
  page.items.map((item) => ({
    type: "simpleCarouselItem",
    mangaId: item.mangaId,
    title: item.title,
    imageUrl: item.imageUrl,
    subtitle: item.subtitle,
    contentRating: item.contentRating,
  }));

export class TempleExtension implements ExtensionImpl<typeof TempleConfig> {
  private readonly rateLimiter = new BasicRateLimiter("templeRateLimiter", {
    numberOfRequests: 4,
    bufferInterval: 1,
    ignoreImages: true,
  });
  private readonly cookies = new TempleCookieInterceptor();
  private readonly interceptor = new TempleInterceptor();

  constructor(private readonly client: TempleClientContract = new TempleClient()) {}

  async initialise(): Promise<void> {
    this.rateLimiter.registerInterceptor();
    this.cookies.registerInterceptor();
    this.interceptor.registerInterceptor();
  }

  async getSettingsForm(): Promise<Form> {
    return new TempleSettingsForm();
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
    ];
  }

  async getDiscoverSectionItems(
    section: DiscoverSection,
    metadata: TemplePageMetadata | undefined,
  ): Promise<PagedResults<DiscoverSectionItem>> {
    if (section.id !== SECTIONS.LATEST) return { items: [] };
    const currentPage = metadata?.page ?? 1;
    if (currentPage > 1) return { items: [] };
    const page = await this.client.getCatalogPage(currentPage);
    return { items: sectionItems(page) };
  }

  async getSortingOptions(_query: SearchQuery<TempleSearchMetadata>): Promise<SortingOption[]> {
    return [{ id: "latest", label: "Recently updated" }];
  }

  async getAdvancedSearchForm(
    query: SearchQuery<TempleSearchMetadata>,
  ): Promise<AdvancedSearchForm> {
    return new TempleAdvancedSearchForm(query);
  }

  async getSearchResults(
    query: SearchQuery<TempleSearchMetadata>,
    metadata: TemplePageMetadata | undefined,
    _sortingOption?: SortingOption,
  ): Promise<PagedResults<SearchResultItem>> {
    const pasted = await this.client.resolvePastedUrl(query.title ?? "");
    if (pasted) return pasted;
    const term = query.title?.trim() ?? "";
    if (!term) {
      const page = await this.client.getCatalogPage(1);
      return { items: searchItems(page) };
    }
    const currentPage = metadata?.page ?? 1;
    const page = await this.client.searchComics(term, currentPage);
    return {
      items: searchItems(page),
      metadata: page.hasNextPage ? { page: currentPage + 1 } : undefined,
    };
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

export const Temple = new TempleExtension();
