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
import { MdxAuthManager } from "./auth.js";
import { MadaraDexClient } from "./client.js";
import { MadaraDexCookieInterceptor } from "./cookies.js";
import { MadaraDexInterceptor } from "./interceptor.js";
import type {
  MadaraCard,
  MadaraCatalogPage,
  MadaraFilterOptions,
  MadaraPageMetadata,
  MadaraSearchMetadata,
} from "./models.js";
import type MadaraDexConfig from "./pbconfig.js";
import { MadaraDexAdvancedSearchForm } from "./search.js";
import { MadaraDexSettingsForm } from "./settings.js";

export interface MadaraDexClientContract {
  getCatalogPage(
    query: SearchQuery<MadaraSearchMetadata>,
    sortingOption: SortingOption | undefined,
    page: number,
  ): Promise<MadaraCatalogPage>;
  getFilterOptions(): Promise<MadaraFilterOptions>;
  getMangaDetails(mangaId: string): Promise<SourceManga>;
  getChapters(sourceManga: SourceManga, sinceDate?: Date): Promise<Chapter[]>;
  getChapterDetails(chapter: Chapter): Promise<ChapterDetails>;
  resolvePastedUrl(query: string): Promise<PagedResults<SearchResultItem> | undefined>;
  invalidateCaches(): void;
}

export const SECTIONS = {
  NEW_SERIES: "newSeries",
  RECENT_UPDATES: "recentUpdates",
  TRENDING: "trending",
  MOST_VIEWED: "mostViewed",
  TOP_RATED: "topRated",
  GENRES: "genres",
} as const;

export const SORTING_OPTIONS: SortingOption[] = [
  { id: "relevance", label: "Relevance" },
  { id: "latest", label: "Recently updated" },
  { id: "alphabet", label: "Title: A–Z" },
  { id: "rating", label: "Top rated" },
  { id: "trending", label: "Trending" },
  { id: "views", label: "Most viewed" },
  { id: "new-manga", label: "Recently added" },
];

const subtitle = (item: MadaraCard): string | undefined => {
  const parts = [
    item.latestChapterTitle,
    item.rating !== undefined ? `★ ${(item.rating * 5).toFixed(1)}` : undefined,
  ].filter((value): value is string => Boolean(value));
  return parts.length > 0 ? parts.join(" · ") : undefined;
};

const searchItems = (page: MadaraCatalogPage): SearchResultItem[] =>
  page.items.map((item) => ({
    mangaId: item.mangaId,
    title: item.title,
    imageUrl: item.imageUrl,
    subtitle: subtitle(item),
    contentRating: item.contentRating,
  }));

const sectionItems = (
  page: MadaraCatalogPage,
  type:
    | "chapterUpdatesCarouselItem"
    | "featuredCarouselItem"
    | "prominentCarouselItem"
    | "simpleCarouselItem",
): DiscoverSectionItem[] =>
  page.items.flatMap((item): DiscoverSectionItem[] => {
    if (type === "chapterUpdatesCarouselItem") {
      if (!item.latestChapterId) return [];
      return [
        {
          type,
          mangaId: item.mangaId,
          chapterId: item.latestChapterId,
          imageUrl: item.imageUrl,
          title: item.title,
          subtitle: item.latestChapterTitle,
          contentRating: item.contentRating,
        },
      ];
    }
    if (type === "featuredCarouselItem") {
      const infoItems: FeaturedCarouselItem["infoItems"] =
        item.rating === undefined
          ? undefined
          : [{ symbol: "star.fill", text: (item.rating * 5).toFixed(1) }];
      return [
        {
          type,
          mangaId: item.mangaId,
          imageUrl: item.imageUrl,
          title: item.title,
          supertitle: item.latestChapterTitle,
          infoItems,
          contentRating: item.contentRating,
        },
      ];
    }
    return [
      {
        type,
        mangaId: item.mangaId,
        imageUrl: item.imageUrl,
        title: item.title,
        subtitle: subtitle(item),
        contentRating: item.contentRating,
      },
    ];
  });

const nextPage = (page: MadaraCatalogPage, currentPage: number): MadaraPageMetadata | undefined =>
  page.hasNextPage ? { page: currentPage + 1 } : undefined;

export class MadaraDexExtension implements ExtensionImpl<typeof MadaraDexConfig> {
  private readonly rateLimiter = new BasicRateLimiter("madaradexRateLimiter", {
    numberOfRequests: 4,
    bufferInterval: 1,
    ignoreImages: true,
  });
  private readonly cookies = new MadaraDexCookieInterceptor();
  private readonly auth = new MdxAuthManager(this.cookies);
  private readonly interceptor = new MadaraDexInterceptor(this.auth);

  constructor(private readonly client: MadaraDexClientContract = new MadaraDexClient()) {}

  async initialise(): Promise<void> {
    this.rateLimiter.registerInterceptor();
    this.interceptor.registerInterceptor();
    this.cookies.registerInterceptor();
  }

  async getSettingsForm(): Promise<Form> {
    return new MadaraDexSettingsForm(this.auth, this.cookies, () => this.client.invalidateCaches());
  }

  async cloudflareBypassCompleted(
    _request: Request,
    cookies: Cookie[],
    _localStorage: Record<string, string>,
  ): Promise<void> {
    this.cookies.acceptSensitiveCookies();
    for (const cookie of cookies) this.cookies.setCookie(cookie);
    this.client.invalidateCaches();
    await this.auth.ensureAuthenticated();
  }

  async getDiscoverSections(): Promise<DiscoverSection[]> {
    return [
      { id: SECTIONS.NEW_SERIES, title: "New series", type: DiscoverSectionType.featured },
      {
        id: SECTIONS.RECENT_UPDATES,
        title: "Recently updated",
        type: DiscoverSectionType.chapterUpdates,
      },
      {
        id: SECTIONS.TRENDING,
        title: "Trending",
        type: DiscoverSectionType.prominentCarousel,
      },
      { id: SECTIONS.MOST_VIEWED, title: "Most viewed", type: DiscoverSectionType.featured },
      {
        id: SECTIONS.TOP_RATED,
        title: "Top rated",
        type: DiscoverSectionType.simpleCarousel,
      },
      { id: SECTIONS.GENRES, title: "Genres", type: DiscoverSectionType.genres },
    ];
  }

  async getDiscoverSectionItems(
    section: DiscoverSection,
    metadata: MadaraPageMetadata | undefined,
  ): Promise<PagedResults<DiscoverSectionItem>> {
    if (section.id === SECTIONS.GENRES) {
      return {
        items: (await this.client.getFilterOptions()).genres.map((genre) => ({
          type: "genresCarouselItem",
          name: genre.title,
          searchQuery: {
            title: "",
            metadata: { genres: [genre.id] } satisfies MadaraSearchMetadata,
          },
          contentRating: contentRatingForTags([genre.title]),
        })),
      };
    }

    const configuration = {
      [SECTIONS.NEW_SERIES]: ["new-manga", "featuredCarouselItem"],
      [SECTIONS.RECENT_UPDATES]: ["latest", "chapterUpdatesCarouselItem"],
      [SECTIONS.TRENDING]: ["trending", "prominentCarouselItem"],
      [SECTIONS.MOST_VIEWED]: ["views", "featuredCarouselItem"],
      [SECTIONS.TOP_RATED]: ["rating", "simpleCarouselItem"],
    } as const;
    const selected = configuration[section.id as keyof typeof configuration];
    if (!selected) return { items: [] };
    const currentPage = metadata?.page ?? 1;
    const page = await this.client.getCatalogPage(
      { title: "" },
      { id: selected[0], label: selected[0] },
      currentPage,
    );
    return { items: sectionItems(page, selected[1]), metadata: nextPage(page, currentPage) };
  }

  async getSortingOptions(_query: SearchQuery<MadaraSearchMetadata>): Promise<SortingOption[]> {
    return SORTING_OPTIONS;
  }

  async getAdvancedSearchForm(
    query: SearchQuery<MadaraSearchMetadata>,
  ): Promise<AdvancedSearchForm> {
    return new MadaraDexAdvancedSearchForm(query, await this.client.getFilterOptions());
  }

  async getSearchResults(
    query: SearchQuery<MadaraSearchMetadata>,
    metadata: MadaraPageMetadata | undefined,
    sortingOption?: SortingOption,
  ): Promise<PagedResults<SearchResultItem>> {
    const pasted = await this.client.resolvePastedUrl(query.title ?? "");
    if (pasted) return pasted;
    const currentPage = metadata?.page ?? 1;
    const page = await this.client.getCatalogPage(query, sortingOption, currentPage);
    return { items: searchItems(page), metadata: nextPage(page, currentPage) };
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

export const MadaraDex = new MadaraDexExtension();
