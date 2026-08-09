import {
  BasicRateLimiter,
  ContentRating,
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
import { AtsumaruClient } from "./client.js";
import { AtsumaruCookieInterceptor } from "./cookies.js";
import { AtsumaruInterceptor } from "./interceptor.js";
import type {
  AtsumaruCatalogPage,
  AtsumaruDiscoveryPreferences,
  AtsumaruFilterOptions,
  AtsumaruHomeFeed,
  AtsumaruPageMetadata,
  AtsumaruSearchMetadata,
  AtsumaruTagGroup,
  AtsumaruTaxonomy,
} from "./models.js";
import type AtsumaruConfig from "./pbconfig.js";
import { AtsumaruAdvancedSearchForm, GENRE_OPTIONS } from "./search.js";
import {
  AtsumaruSettingsForm,
  getAtsumaruDiscoveryPreferences,
  getShowAlternateTranslations,
} from "./settings.js";

export interface AtsumaruClientContract {
  getHomePage(
    feed: AtsumaruHomeFeed,
    offset: number,
    preferences: AtsumaruDiscoveryPreferences,
  ): Promise<AtsumaruCatalogPage>;
  getSearchPage(
    query: SearchQuery<AtsumaruSearchMetadata>,
    sortingOption: SortingOption | undefined,
    page: number,
  ): Promise<AtsumaruCatalogPage>;
  getFilterOptions(): Promise<AtsumaruFilterOptions>;
  getMangaDetails(mangaId: string): Promise<SourceManga>;
  getChapters(
    sourceManga: SourceManga,
    sinceDate: Date | undefined,
    includeAlternates: boolean,
  ): Promise<Chapter[]>;
  getChapterDetails(chapter: Chapter): Promise<ChapterDetails>;
  resolvePastedUrl(query: string): Promise<PagedResults<SearchResultItem> | undefined>;
  invalidateCaches(): void;
}

export const SECTIONS = {
  HOT_UPDATES: "hotUpdates",
  RECENTLY_UPDATED: "recentlyUpdated",
  POPULAR: "popular",
  RISING: "rising",
  HOT_ARRIVALS: "hotArrivals",
  MOST_BOOKMARKED: "mostBookmarked",
  GENRE_SPOTLIGHT: "genreSpotlight",
  MOST_TALKED_ABOUT: "mostTalkedAbout",
  RECENTLY_ADDED: "recentlyAdded",
  BINGE_WORTHY: "bingeWorthy",
  MOST_POLARIZING: "mostPolarizing",
  HIDDEN_GEMS: "hiddenGems",
  TOP_RATED: "topRated",
  GENRES: "genres",
} as const;

export const SORTING_OPTIONS: SortingOption[] = [
  { id: "relevance", label: "Relevance" },
  { id: "title", label: "Title: A–Z" },
  { id: "most-viewed", label: "Most viewed" },
  { id: "trending", label: "Trending" },
  { id: "recently-added", label: "Recently added" },
  { id: "released", label: "Newest release" },
  { id: "topRated", label: "Top rated" },
];

type CarouselType = "featuredCarouselItem" | "prominentCarouselItem" | "simpleCarouselItem";

const SECTION_CONFIGURATION: Readonly<
  Record<
    Exclude<(typeof SECTIONS)[keyof typeof SECTIONS], "genres">,
    { title: string; sectionType: DiscoverSectionType; itemType: CarouselType }
  >
> = {
  hotUpdates: {
    title: "Hot updates",
    sectionType: DiscoverSectionType.featured,
    itemType: "featuredCarouselItem",
  },
  recentlyUpdated: {
    title: "Recently updated",
    sectionType: DiscoverSectionType.simpleCarousel,
    itemType: "simpleCarouselItem",
  },
  popular: {
    title: "Popular",
    sectionType: DiscoverSectionType.featured,
    itemType: "featuredCarouselItem",
  },
  rising: {
    title: "Rising",
    sectionType: DiscoverSectionType.prominentCarousel,
    itemType: "prominentCarouselItem",
  },
  hotArrivals: {
    title: "Hot arrivals",
    sectionType: DiscoverSectionType.prominentCarousel,
    itemType: "prominentCarouselItem",
  },
  mostBookmarked: {
    title: "Most bookmarked",
    sectionType: DiscoverSectionType.simpleCarousel,
    itemType: "simpleCarouselItem",
  },
  genreSpotlight: {
    title: "Genre spotlight",
    sectionType: DiscoverSectionType.featured,
    itemType: "featuredCarouselItem",
  },
  mostTalkedAbout: {
    title: "Most talked about",
    sectionType: DiscoverSectionType.simpleCarousel,
    itemType: "simpleCarouselItem",
  },
  recentlyAdded: {
    title: "Recently added",
    sectionType: DiscoverSectionType.prominentCarousel,
    itemType: "prominentCarouselItem",
  },
  bingeWorthy: {
    title: "Binge-worthy",
    sectionType: DiscoverSectionType.featured,
    itemType: "featuredCarouselItem",
  },
  mostPolarizing: {
    title: "Most polarizing",
    sectionType: DiscoverSectionType.prominentCarousel,
    itemType: "prominentCarouselItem",
  },
  hiddenGems: {
    title: "Hidden gems",
    sectionType: DiscoverSectionType.featured,
    itemType: "featuredCarouselItem",
  },
  topRated: {
    title: "Top rated",
    sectionType: DiscoverSectionType.simpleCarousel,
    itemType: "simpleCarouselItem",
  },
};

const formatCount = (value: number): string => {
  if (value < 1_000) return String(Math.trunc(value));
  if (value < 1_000_000) return `${Number((value / 1_000).toFixed(1))}K`;
  if (value < 1_000_000_000) return `${Number((value / 1_000_000).toFixed(1))}M`;
  return `${Number((value / 1_000_000_000).toFixed(1))}B`;
};

const subtitle = (item: AtsumaruCatalogPage["items"][number]): string | undefined => {
  const parts = [
    item.rating !== undefined ? `★ ${(item.rating * 10).toFixed(1)}` : undefined,
    item.views !== undefined ? `${formatCount(item.views)} views` : undefined,
    item.chapterCount !== undefined
      ? `${item.chapterCount} ${item.chapterCount === 1 ? "chapter" : "chapters"}`
      : undefined,
  ].filter((value): value is string => Boolean(value));
  return parts.length > 0 ? parts.join(" · ") : undefined;
};

const searchItems = (page: AtsumaruCatalogPage): SearchResultItem[] =>
  page.items.map((item) => ({
    mangaId: item.mangaId,
    title: item.title,
    imageUrl: item.imageUrl,
    subtitle: subtitle(item),
    contentRating: item.contentRating,
  }));

const sectionItems = (page: AtsumaruCatalogPage, type: CarouselType): DiscoverSectionItem[] =>
  page.items.map((item) => {
    if (type === "featuredCarouselItem") {
      const rating =
        item.rating !== undefined
          ? ({ symbol: "star.fill", text: (item.rating * 10).toFixed(1) } as const)
          : undefined;
      const views =
        item.views !== undefined
          ? ({ symbol: "eye.fill", text: formatCount(item.views) } as const)
          : undefined;
      const infoItems: FeaturedCarouselItem["infoItems"] =
        rating && views ? [rating, views] : rating ? [rating] : views ? [views] : undefined;
      return {
        type,
        mangaId: item.mangaId,
        title: item.title,
        imageUrl: item.imageUrl,
        supertitle: [item.type, item.medium].filter(Boolean).join(" · ") || undefined,
        infoItems,
        contentRating: item.contentRating,
      };
    }
    return {
      type,
      mangaId: item.mangaId,
      title: item.title,
      imageUrl: item.imageUrl,
      subtitle: subtitle(item),
      contentRating: item.contentRating,
    };
  });

const nextSearchPage = (page: AtsumaruCatalogPage): AtsumaruPageMetadata | undefined =>
  page.hasNextPage ? { page: (page.page ?? 1) + 1 } : undefined;

const nextFeedOffset = (page: AtsumaruCatalogPage): AtsumaruPageMetadata | undefined =>
  page.hasNextPage
    ? { offset: page.nextOffset ?? (page.offset ?? 0) + page.items.length }
    : undefined;

const freezeTaxonomy = (value: AtsumaruTaxonomy): AtsumaruTaxonomy =>
  Object.freeze({ ...value }) as AtsumaruTaxonomy;

const freezeTaxonomyList = (values: readonly AtsumaruTaxonomy[]): AtsumaruTaxonomy[] =>
  Object.freeze(values.map(freezeTaxonomy)) as unknown as AtsumaruTaxonomy[];

const freezeFilterOptions = (filters: AtsumaruFilterOptions): AtsumaruFilterOptions => {
  const tagGroups = filters.tagGroups
    ? (Object.freeze(
        filters.tagGroups.map(
          (group): AtsumaruTagGroup =>
            Object.freeze({
              ...group,
              tags: freezeTaxonomyList(group.tags),
            }) as AtsumaruTagGroup,
        ),
      ) as unknown as AtsumaruTagGroup[])
    : undefined;
  return Object.freeze({
    ...filters,
    genres: freezeTaxonomyList(filters.genres),
    statuses: freezeTaxonomyList(filters.statuses),
    tags: freezeTaxonomyList(filters.tags),
    types: freezeTaxonomyList(filters.types),
    ...(filters.mediums && { mediums: freezeTaxonomyList(filters.mediums) }),
    ...(filters.contentRatings && {
      contentRatings: freezeTaxonomyList(filters.contentRatings),
    }),
    ...(tagGroups && { tagGroups }),
  }) as AtsumaruFilterOptions;
};

const preferencesForFeed = (
  filters: AtsumaruFilterOptions,
  feed: AtsumaruHomeFeed,
): AtsumaruDiscoveryPreferences => {
  const stored = getAtsumaruDiscoveryPreferences(filters);
  const genre =
    filters.genres.find((candidate) => candidate.id === stored.genreSpotlight)?.name ??
    GENRE_OPTIONS.find((candidate) => candidate.id === stored.genreSpotlight)?.title ??
    stored.genreSpotlight;
  const timeframe =
    feed === "mostBookmarked"
      ? stored.bookmarksTimeframe
      : feed === "mostTalkedAbout"
        ? stored.talkedAboutTimeframe
        : stored.popularTimeframe;
  return {
    adult: stored.adult,
    types: [...stored.types],
    mediums: [...stored.mediums],
    excludedTags: [...stored.excludedTags],
    timeframe,
    genre,
  };
};

export class AtsumaruExtension implements ExtensionImpl<typeof AtsumaruConfig> {
  private readonly rateLimiter = new BasicRateLimiter("atsumaruRateLimiter", {
    numberOfRequests: 4,
    bufferInterval: 1,
    ignoreImages: true,
  });
  private readonly cookies = new AtsumaruCookieInterceptor();
  private readonly interceptor = new AtsumaruInterceptor();
  private filterOptionsSnapshot: Promise<AtsumaruFilterOptions> | undefined;

  constructor(private readonly client: AtsumaruClientContract = new AtsumaruClient()) {}

  private getFilterOptionsSnapshot(): Promise<AtsumaruFilterOptions> {
    const existing = this.filterOptionsSnapshot;
    if (existing) return existing;

    const pending = Promise.resolve()
      .then(() => this.client.getFilterOptions())
      .then(freezeFilterOptions);
    const tracked = pending.catch((error: unknown) => {
      if (this.filterOptionsSnapshot === tracked) this.filterOptionsSnapshot = undefined;
      throw error;
    });
    this.filterOptionsSnapshot = tracked;
    return tracked;
  }

  async initialise(): Promise<void> {
    this.rateLimiter.registerInterceptor();
    this.cookies.registerInterceptor();
    this.interceptor.registerInterceptor();
  }

  async getSettingsForm(): Promise<Form> {
    return new AtsumaruSettingsForm(await this.getFilterOptionsSnapshot());
  }

  async cloudflareBypassCompleted(
    _request: Request,
    cookies: Cookie[],
    _localStorage: Record<string, string>,
  ): Promise<void> {
    for (const cookie of cookies) this.cookies.setCookie(cookie);
    this.client.invalidateCaches();
    this.filterOptionsSnapshot = undefined;
  }

  async getDiscoverSections(): Promise<DiscoverSection[]> {
    return [
      ...Object.entries(SECTION_CONFIGURATION).map(([id, configuration]) => ({
        id,
        title: configuration.title,
        type: configuration.sectionType,
      })),
      { id: SECTIONS.GENRES, title: "Genres", type: DiscoverSectionType.genres },
    ];
  }

  async getDiscoverSectionItems(
    section: DiscoverSection,
    metadata: AtsumaruPageMetadata | undefined,
  ): Promise<PagedResults<DiscoverSectionItem>> {
    if (section.id === SECTIONS.GENRES) {
      const filters = await this.getFilterOptionsSnapshot();
      return {
        items: filters.genres.map((genre) => {
          const contentRating = contentRatingForTags([genre.name]);
          return {
            type: "genresCarouselItem",
            name: genre.name,
            searchQuery: {
              title: "",
              metadata: {
                genres: { [genre.id]: "included" },
                ...(contentRating === ContentRating.ADULT && { adult: "adult" as const }),
              } satisfies AtsumaruSearchMetadata,
            },
            contentRating,
          };
        }),
      };
    }

    const configuration = Object.prototype.hasOwnProperty.call(SECTION_CONFIGURATION, section.id)
      ? SECTION_CONFIGURATION[section.id as keyof typeof SECTION_CONFIGURATION]
      : undefined;
    if (!configuration) return { items: [] };
    const feed = section.id as AtsumaruHomeFeed;
    const offset = metadata?.offset ?? 0;
    const page = await this.client.getHomePage(
      feed,
      offset,
      preferencesForFeed(await this.getFilterOptionsSnapshot(), feed),
    );
    return {
      items: sectionItems(page, configuration.itemType),
      metadata: nextFeedOffset(page),
    };
  }

  async getSortingOptions(_query: SearchQuery<AtsumaruSearchMetadata>): Promise<SortingOption[]> {
    return SORTING_OPTIONS.map((option) => ({ ...option }));
  }

  async getAdvancedSearchForm(
    query: SearchQuery<AtsumaruSearchMetadata>,
  ): Promise<AdvancedSearchForm> {
    return new AtsumaruAdvancedSearchForm(query, await this.getFilterOptionsSnapshot());
  }

  async getSearchResults(
    query: SearchQuery<AtsumaruSearchMetadata>,
    metadata: AtsumaruPageMetadata | undefined,
    sortingOption?: SortingOption,
  ): Promise<PagedResults<SearchResultItem>> {
    const pasted = await this.client.resolvePastedUrl(query.title ?? "");
    if (pasted) return pasted;
    const page = await this.client.getSearchPage(query, sortingOption, metadata?.page ?? 1);
    return { items: searchItems(page), metadata: nextSearchPage(page) };
  }

  async getMangaDetails(mangaId: string): Promise<SourceManga> {
    return this.client.getMangaDetails(mangaId);
  }

  async getChapters(sourceManga: SourceManga, sinceDate?: Date): Promise<Chapter[]> {
    return this.client.getChapters(sourceManga, sinceDate, getShowAlternateTranslations());
  }

  async getChapterDetails(chapter: Chapter): Promise<ChapterDetails> {
    return this.client.getChapterDetails(chapter);
  }
}

export const Atsumaru = new AtsumaruExtension();
