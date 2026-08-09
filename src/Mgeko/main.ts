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
  type FeaturedCarouselItem,
  type Form,
  type PagedResults,
  type Request,
  type SearchQuery,
  type SearchResultItem,
  type SortingOption,
  type SourceManga,
} from "@paperback/types";

import { contentRatingForTags } from "../shared/html.js";
import { MgekoClient, type MgekoBrowsePage } from "./client.js";
import { MgekoCookieInterceptor } from "./cookies.js";
import { MgekoInterceptor } from "./interceptor.js";
import type { MgekoFilterOptions, MgekoPageMetadata, MgekoSearchMetadata } from "./models.js";
import type MgekoConfig from "./pbconfig.js";
import { MgekoAdvancedSearchForm } from "./search.js";
import { MgekoSettingsForm, getSafeMode } from "./settings.js";

export interface MgekoClientContract {
  getBrowsePage(
    query: SearchQuery<MgekoSearchMetadata>,
    sortingOption: SortingOption | undefined,
    page: number,
    safeMode: boolean,
  ): Promise<MgekoBrowsePage>;
  getFilterOptions(): Promise<MgekoFilterOptions>;
  getMangaDetails(mangaId: string): Promise<SourceManga>;
  getChapters(sourceManga: SourceManga, sinceDate?: Date): Promise<Chapter[]>;
  getChapterDetails(chapter: Chapter): Promise<ChapterDetails>;
  resolvePastedUrl(query: string): Promise<PagedResults<SearchResultItem> | undefined>;
  invalidateCaches(): void;
}

export const SECTIONS = {
  POPULAR_ALL_TIME: "popularAllTime",
  TOP_RATED: "topRated",
  LATEST: "latest",
  RECENTLY_ADDED: "recentlyAdded",
  POPULAR_DAILY: "popularDaily",
  GENRES: "genres",
} as const;

export const SORTING_OPTIONS: SortingOption[] = [
  { id: "latest", label: "Recently updated" },
  { id: "recently_added", label: "Recently added" },
  { id: "popular_daily", label: "Popular today" },
  { id: "popular_weekly", label: "Popular this week" },
  { id: "popular_monthly", label: "Popular this month" },
  { id: "popular_all_time", label: "Popular all time" },
  { id: "rating", label: "Top rated" },
  { id: "az", label: "Title: A–Z" },
  { id: "za", label: "Title: Z–A" },
];

const formatCount = (value: number): string => {
  if (value < 1_000) return String(value);
  if (value < 1_000_000) return `${Number((value / 1_000).toFixed(1))}K`;
  return `${Number((value / 1_000_000).toFixed(1))}M`;
};

const subtitle = (rating?: number, views?: number): string | undefined => {
  const parts = [
    rating !== undefined ? `★ ${(rating * 5).toFixed(1)}` : undefined,
    views !== undefined ? `${formatCount(views)} views` : undefined,
  ].filter((value): value is string => Boolean(value));
  return parts.length > 0 ? parts.join(" · ") : undefined;
};

const searchItems = (page: MgekoBrowsePage): SearchResultItem[] =>
  page.items.map((item) => ({
    mangaId: item.mangaId,
    title: item.title,
    imageUrl: item.imageUrl,
    subtitle: subtitle(item.rating, item.views),
    contentRating: item.contentRating,
  }));

const sectionItems = (
  page: MgekoBrowsePage,
  type: "featuredCarouselItem" | "prominentCarouselItem" | "simpleCarouselItem",
): DiscoverSectionItem[] =>
  page.items.map((item) => {
    if (type === "featuredCarouselItem") {
      const rating =
        item.rating !== undefined
          ? ({ symbol: "star.fill", text: (item.rating * 5).toFixed(1) } as const)
          : undefined;
      const views =
        item.views !== undefined
          ? ({ symbol: "flame.fill", text: formatCount(item.views) } as const)
          : undefined;
      const infoItems: FeaturedCarouselItem["infoItems"] =
        rating && views ? [rating, views] : rating ? [rating] : views ? [views] : undefined;
      return {
        type,
        mangaId: item.mangaId,
        title: item.title,
        imageUrl: item.imageUrl,
        supertitle: item.badge,
        infoItems,
        contentRating: item.contentRating,
      };
    }
    return {
      type,
      mangaId: item.mangaId,
      title: item.title,
      imageUrl: item.imageUrl,
      subtitle: subtitle(item.rating, item.views),
      contentRating: item.contentRating,
    };
  });

const nextPage = (page: MgekoBrowsePage): MgekoPageMetadata | undefined =>
  page.page < page.pageCount ? { page: page.page + 1 } : undefined;

export class MgekoExtension implements ExtensionImpl<typeof MgekoConfig> {
  private readonly rateLimiter = new BasicRateLimiter("mgekoRateLimiter", {
    numberOfRequests: 4,
    bufferInterval: 1,
    ignoreImages: true,
  });
  private readonly cookies = new MgekoCookieInterceptor();
  private readonly interceptor = new MgekoInterceptor();

  constructor(private readonly client: MgekoClientContract = new MgekoClient()) {}

  async initialise(): Promise<void> {
    this.rateLimiter.registerInterceptor();
    this.cookies.registerInterceptor();
    this.interceptor.registerInterceptor();
  }

  async getSettingsForm(): Promise<Form> {
    return new MgekoSettingsForm();
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
      {
        id: SECTIONS.POPULAR_ALL_TIME,
        title: "Popular all time",
        type: DiscoverSectionType.featured,
      },
      { id: SECTIONS.TOP_RATED, title: "Top rated", type: DiscoverSectionType.prominentCarousel },
      { id: SECTIONS.LATEST, title: "Latest updates", type: DiscoverSectionType.simpleCarousel },
      {
        id: SECTIONS.RECENTLY_ADDED,
        title: "Recently added",
        type: DiscoverSectionType.prominentCarousel,
      },
      {
        id: SECTIONS.POPULAR_DAILY,
        title: "Popular today",
        type: DiscoverSectionType.simpleCarousel,
      },
      { id: SECTIONS.GENRES, title: "Genres", type: DiscoverSectionType.genres },
    ];
  }

  async getDiscoverSectionItems(
    section: DiscoverSection,
    metadata: MgekoPageMetadata | undefined,
  ): Promise<PagedResults<DiscoverSectionItem>> {
    if (section.id === SECTIONS.GENRES) {
      return {
        items: (await this.client.getFilterOptions()).genres.map((genre) => ({
          type: "genresCarouselItem",
          name: genre.title,
          searchQuery: {
            title: "",
            metadata: { genres: { [genre.id]: "included" } } satisfies MgekoSearchMetadata,
          },
          contentRating: contentRatingForTags([genre.title]),
        })),
      };
    }

    const configuration = {
      [SECTIONS.POPULAR_ALL_TIME]: ["popular_all_time", "featuredCarouselItem"],
      [SECTIONS.TOP_RATED]: ["rating", "prominentCarouselItem"],
      [SECTIONS.LATEST]: ["latest", "simpleCarouselItem"],
      [SECTIONS.RECENTLY_ADDED]: ["recently_added", "prominentCarouselItem"],
      [SECTIONS.POPULAR_DAILY]: ["popular_daily", "simpleCarouselItem"],
    } as const;
    const selected = configuration[section.id as keyof typeof configuration];
    if (!selected) return { items: [] };
    const pageNumber = metadata?.page ?? 1;
    const page = await this.client.getBrowsePage(
      { title: "" },
      { id: selected[0], label: selected[0] },
      pageNumber,
      getSafeMode(),
    );
    return {
      items: sectionItems(page, selected[1]),
      metadata: nextPage(page),
    };
  }

  async getSortingOptions(_query: SearchQuery<MgekoSearchMetadata>): Promise<SortingOption[]> {
    return SORTING_OPTIONS;
  }

  async getAdvancedSearchForm(
    query: SearchQuery<MgekoSearchMetadata>,
  ): Promise<AdvancedSearchForm> {
    return new MgekoAdvancedSearchForm(query, (await this.client.getFilterOptions()).genres);
  }

  async getSearchResults(
    query: SearchQuery<MgekoSearchMetadata>,
    metadata: MgekoPageMetadata | undefined,
    sortingOption?: SortingOption,
  ): Promise<PagedResults<SearchResultItem>> {
    const pasted = await this.client.resolvePastedUrl(query.title ?? "");
    if (pasted) return pasted;
    const page = await this.client.getBrowsePage(
      query,
      sortingOption,
      metadata?.page ?? 1,
      getSafeMode(),
    );
    return { items: searchItems(page), metadata: nextPage(page) };
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

export const Mgeko = new MgekoExtension();
