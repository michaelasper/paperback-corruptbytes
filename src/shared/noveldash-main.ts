import {
  BasicRateLimiter,
  DiscoverSectionType,
  type AdvancedSearchForm,
  type Chapter,
  type ChapterDetails,
  type Cookie,
  type DiscoverSection,
  type DiscoverSectionItem,
  type FeaturedCarouselItem,
  type Form,
  type PagedResults,
  type Request,
  type SearchQuery,
  type SearchResultItem,
  type SortingOption,
  type SourceManga,
  type Tag,
} from "@paperback/types";

import { contentRatingForTags } from "./html.js";
import {
  fetchNovelDashAccountStatus,
  NovelDashCookieInterceptor,
  persistNovelDashCookies,
} from "./noveldash-auth.js";
import { NovelDashClient } from "./noveldash-client.js";
import { NovelDashInterceptor } from "./noveldash-interceptor.js";
import type {
  NovelDashPageMetadata,
  NovelDashSearchMetadata,
  NovelDashSite,
} from "./noveldash-models.js";
import { NOVELDASH_CATALOG_PAGE_SIZE } from "./noveldash-network.js";
import type { NovelDashCatalogItem, ParsedNovelDashCatalog } from "./noveldash-parsers.js";
import { NovelDashAdvancedSearchForm } from "./noveldash-search.js";
import { getNovelDashShowLockedChapters, NovelDashSettingsForm } from "./noveldash-settings.js";

export interface NovelDashClientContract {
  getCatalogPage(
    query: SearchQuery<NovelDashSearchMetadata>,
    sortingOption: SortingOption | undefined,
    page: number,
    limit?: number,
  ): Promise<ParsedNovelDashCatalog>;
  getGenres(): Promise<Tag[]>;
  getMangaDetails(mangaId: string): Promise<SourceManga>;
  getChapters(
    sourceManga: SourceManga,
    options?: { showLocked?: boolean; sinceDate?: Date },
  ): Promise<Chapter[]>;
  getChapterDetails(chapter: Chapter): Promise<ChapterDetails>;
  resolvePastedUrl(query: string): Promise<PagedResults<SearchResultItem> | undefined>;
  invalidateCaches(): void;
}

export const NOVELDASH_SECTIONS = {
  LATEST: "latest",
  TRENDING: "trending",
  NEW: "new",
  GENRES: "genres",
} as const;

export const NOVELDASH_SORTING_OPTIONS: SortingOption[] = [
  { id: "updated", label: "Recently updated" },
  { id: "trending", label: "Trending" },
  { id: "popular", label: "Most popular" },
  { id: "views", label: "Most viewed" },
  { id: "rating", label: "Highest rated" },
  { id: "longest", label: "Most chapters" },
  { id: "newest", label: "Recently added" },
];

const searchItems = (page: ParsedNovelDashCatalog): SearchResultItem[] =>
  page.items.map((item) => ({
    mangaId: item.mangaId,
    title: item.title,
    imageUrl: item.imageUrl,
    subtitle: [item.type, item.status].filter(Boolean).join(" · ") || undefined,
    contentRating: item.contentRating,
  }));

const featuredItems = (items: readonly NovelDashCatalogItem[]): DiscoverSectionItem[] =>
  items.map((item) => {
    const rating =
      item.rating === undefined
        ? undefined
        : ({ symbol: "star.fill", text: (item.rating * 10).toFixed(1) } as const);
    const status = item.status ? ({ symbol: "book.fill", text: item.status } as const) : undefined;
    const infoItems: FeaturedCarouselItem["infoItems"] =
      rating && status ? [rating, status] : rating ? [rating] : status ? [status] : undefined;
    return {
      type: "featuredCarouselItem",
      mangaId: item.mangaId,
      title: item.title,
      imageUrl: item.imageUrl,
      supertitle: item.type,
      infoItems,
      contentRating: item.contentRating,
    };
  });

const latestItems = (items: readonly NovelDashCatalogItem[]): DiscoverSectionItem[] =>
  items.flatMap((item): DiscoverSectionItem[] =>
    item.latestChapterId
      ? [
          {
            type: "chapterUpdatesCarouselItem",
            mangaId: item.mangaId,
            chapterId: item.latestChapterId,
            title: item.title,
            imageUrl: item.imageUrl,
            subtitle:
              item.latestChapterTitle ||
              (item.latestChapterNumber === undefined
                ? item.type
                : `Chapter ${item.latestChapterNumber}`),
            publishDate: item.latestPublishDate,
            contentRating: item.contentRating,
          },
        ]
      : [],
  );

const newItems = (items: readonly NovelDashCatalogItem[]): DiscoverSectionItem[] =>
  items.map((item) => ({
    type: "prominentCarouselItem",
    mangaId: item.mangaId,
    title: item.title,
    imageUrl: item.imageUrl,
    subtitle: [item.type, item.status].filter(Boolean).join(" · ") || undefined,
    contentRating: item.contentRating,
  }));

const nextPage = (page: ParsedNovelDashCatalog): NovelDashPageMetadata | undefined =>
  page.hasMore ||
  (page.totalPages > 0 && page.page < page.totalPages) ||
  (page.totalPages === 0 && page.items.length >= NOVELDASH_CATALOG_PAGE_SIZE)
    ? { page: page.page + 1 }
    : undefined;

export class NovelDashExtension {
  private readonly rateLimiter: BasicRateLimiter;
  private readonly cookieInterceptor: NovelDashCookieInterceptor;
  private readonly requestInterceptor: NovelDashInterceptor;
  private genresPromise?: Promise<Tag[]>;

  constructor(
    readonly site: NovelDashSite,
    private readonly client: NovelDashClientContract = new NovelDashClient(site),
  ) {
    this.rateLimiter = new BasicRateLimiter(`${site.key}RateLimiter`, {
      numberOfRequests: 5,
      bufferInterval: 4,
      ignoreImages: true,
    });
    this.cookieInterceptor = new NovelDashCookieInterceptor(site);
    this.requestInterceptor = new NovelDashInterceptor(site);
  }

  async initialise(): Promise<void> {
    this.rateLimiter.registerInterceptor();
    this.cookieInterceptor.registerInterceptor();
    this.requestInterceptor.registerInterceptor();
  }

  async getSettingsForm(): Promise<Form> {
    return new NovelDashSettingsForm(
      this.site,
      this.cookieInterceptor,
      await fetchNovelDashAccountStatus(this.site, this.cookieInterceptor),
      () => this.invalidateCaches(),
    );
  }

  async cloudflareBypassCompleted(
    _request: Request,
    cookies: Cookie[],
    _localStorage: Record<string, string>,
  ): Promise<void> {
    persistNovelDashCookies(this.site, this.cookieInterceptor, cookies);
    this.invalidateCaches();
  }

  async getDiscoverSections(): Promise<DiscoverSection[]> {
    return [
      {
        id: NOVELDASH_SECTIONS.LATEST,
        title: "Latest free updates",
        type: DiscoverSectionType.chapterUpdates,
      },
      {
        id: NOVELDASH_SECTIONS.TRENDING,
        title: "Trending",
        type: DiscoverSectionType.featured,
      },
      {
        id: NOVELDASH_SECTIONS.NEW,
        title: "Recently added",
        type: DiscoverSectionType.prominentCarousel,
      },
      {
        id: NOVELDASH_SECTIONS.GENRES,
        title: "Genres",
        type: DiscoverSectionType.genres,
      },
    ];
  }

  async getDiscoverSectionItems(
    section: DiscoverSection,
    metadata?: NovelDashPageMetadata,
  ): Promise<PagedResults<DiscoverSectionItem>> {
    if (section.id === NOVELDASH_SECTIONS.GENRES) {
      return {
        items: (await this.getGenres()).map((genre) => ({
          type: "genresCarouselItem",
          name: genre.title,
          searchQuery: {
            title: "",
            metadata: { genres: { [genre.id]: "included" } } satisfies NovelDashSearchMetadata,
          },
          contentRating: contentRatingForTags([genre.title]),
        })),
      };
    }
    if (
      section.id !== NOVELDASH_SECTIONS.LATEST &&
      section.id !== NOVELDASH_SECTIONS.TRENDING &&
      section.id !== NOVELDASH_SECTIONS.NEW
    ) {
      return { items: [] };
    }

    const pageNumber = metadata?.page ?? 1;
    const sortingId =
      section.id === NOVELDASH_SECTIONS.TRENDING
        ? "trending"
        : section.id === NOVELDASH_SECTIONS.NEW
          ? "newest"
          : "updated";
    const page = await this.client.getCatalogPage(
      { title: "" },
      { id: sortingId, label: sortingId },
      pageNumber,
    );
    const items =
      section.id === NOVELDASH_SECTIONS.TRENDING
        ? featuredItems(page.items)
        : section.id === NOVELDASH_SECTIONS.NEW
          ? newItems(page.items)
          : latestItems(page.items);
    return { items, metadata: nextPage(page) };
  }

  async getSortingOptions(_query: SearchQuery<NovelDashSearchMetadata>): Promise<SortingOption[]> {
    return NOVELDASH_SORTING_OPTIONS;
  }

  async getAdvancedSearchForm(
    query: SearchQuery<NovelDashSearchMetadata>,
  ): Promise<AdvancedSearchForm> {
    return new NovelDashAdvancedSearchForm(query, await this.getGenres());
  }

  async getSearchResults(
    query: SearchQuery<NovelDashSearchMetadata>,
    metadata: NovelDashPageMetadata | undefined,
    sortingOption?: SortingOption,
  ): Promise<PagedResults<SearchResultItem>> {
    const pasted = await this.client.resolvePastedUrl(query.title ?? "");
    if (pasted) return pasted;
    const page = await this.client.getCatalogPage(query, sortingOption, metadata?.page ?? 1);
    return { items: searchItems(page), metadata: nextPage(page) };
  }

  async getMangaDetails(mangaId: string): Promise<SourceManga> {
    return this.client.getMangaDetails(mangaId);
  }

  async getChapters(sourceManga: SourceManga, sinceDate?: Date): Promise<Chapter[]> {
    return this.client.getChapters(sourceManga, {
      showLocked: getNovelDashShowLockedChapters(this.site),
      ...(sinceDate && { sinceDate }),
    });
  }

  async getChapterDetails(chapter: Chapter): Promise<ChapterDetails> {
    return this.client.getChapterDetails(chapter);
  }

  private getGenres(): Promise<Tag[]> {
    if (!this.genresPromise) {
      this.genresPromise = this.client.getGenres().catch((error: unknown) => {
        this.genresPromise = undefined;
        throw error;
      });
    }
    return this.genresPromise;
  }

  private invalidateCaches(): void {
    this.genresPromise = undefined;
    this.client.invalidateCaches();
  }
}
