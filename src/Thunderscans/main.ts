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
  type JSONObject,
  type PagedResults,
  type Request,
  type SearchQuery,
  type SearchResultItem,
  type SortingOption,
  type SourceManga,
  type Tag,
  type UpdateManager,
} from "@paperback/types";

import { contentRatingForTags } from "../shared/html.js";
import { fetchAccountStatus, persistThunderCookies } from "./auth.js";
import { ThunderClient } from "./client.js";
import { ThunderCookieInterceptor } from "./cookies.js";
import { ThunderInterceptor } from "./interceptor.js";
import type {
  HomeFeedId,
  ParsedHomeFeed,
  ParsedListPage,
  ThunderListItem,
  ThunderSearchMetadata,
} from "./models.js";
import { hasAdvancedFilters } from "./network.js";
import type ThunderScansConfig from "./pbconfig.js";
import { ThunderAdvancedSearchForm } from "./search.js";
import { getShowLockedChapters, ThunderSettingsForm } from "./settings.js";

export interface PageMetadata extends JSONObject {
  page?: number;
}

export interface ThunderClientContract {
  getDirectoryPage(
    query: SearchQuery<ThunderSearchMetadata>,
    sortingOption: SortingOption | undefined,
    page: number,
  ): Promise<ParsedListPage>;
  getHomeFeed(feed: HomeFeedId, page?: number): Promise<ParsedHomeFeed>;
  getGenres(): Promise<Tag[]>;
  getAutocompleteResults(
    title: string,
    metadata?: ThunderSearchMetadata,
  ): Promise<ThunderListItem[]>;
  getMangaDetails(mangaId: string): Promise<SourceManga>;
  getChapters(sourceManga: SourceManga, showLocked: boolean): Promise<Chapter[]>;
  getChapterDetails(chapter: Chapter): Promise<ChapterDetails>;
  resolvePastedUrl(query: string): Promise<PagedResults<SearchResultItem> | undefined>;
  invalidateAuthenticationCaches(): void;
}

export const SECTIONS = {
  POPULAR: "popular",
  EDITORS: "editors",
  LATEST_COMICS: "latestComics",
  LATEST_NOVELS: "latestNovels",
  RECENTLY_ADDED: "recentlyAdded",
  GENRES: "genres",
} as const;

export const SORTING_OPTIONS: SortingOption[] = [
  { id: "update", label: "Recently updated" },
  { id: "latest", label: "Recently added" },
  { id: "popular", label: "Most popular" },
  { id: "title", label: "Title: A–Z" },
  { id: "titlereverse", label: "Title: Z–A" },
];

const searchItems = (items: ThunderListItem[]): SearchResultItem[] =>
  items.map((item) => ({
    mangaId: item.mangaId,
    title: item.title,
    imageUrl: item.imageUrl,
    subtitle: item.subtitle,
    contentRating: item.contentRating,
  }));

const prominentItems = (items: ThunderListItem[]): DiscoverSectionItem[] =>
  items.map((item) => ({
    type: "prominentCarouselItem",
    mangaId: item.mangaId,
    title: item.title,
    imageUrl: item.imageUrl,
    subtitle: item.subtitle,
    contentRating: item.contentRating,
  }));

const featuredItems = (items: ThunderListItem[]): DiscoverSectionItem[] =>
  items.map((item) => {
    const rating =
      item.rating === undefined
        ? undefined
        : ({ symbol: "star.fill", text: (item.rating * 10).toFixed(1) } as const);
    const status = item.status ? ({ symbol: "book.fill", text: item.status } as const) : undefined;
    return {
      type: "featuredCarouselItem",
      mangaId: item.mangaId,
      title: item.title,
      imageUrl: item.imageUrl,
      infoItems:
        rating && status ? [rating, status] : rating ? [rating] : status ? [status] : undefined,
      contentRating: item.contentRating,
    };
  });

const updateItems = (items: ThunderListItem[]): DiscoverSectionItem[] =>
  items.flatMap((item): DiscoverSectionItem[] =>
    item.latestChapterId
      ? [
          {
            type: "chapterUpdatesCarouselItem",
            mangaId: item.mangaId,
            chapterId: item.latestChapterId,
            title: item.title,
            imageUrl: item.imageUrl,
            subtitle: item.subtitle,
            publishDate: item.publishDate,
            contentRating: item.contentRating,
          },
        ]
      : [],
  );

export class ThunderScansExtension implements ExtensionImpl<typeof ThunderScansConfig> {
  private readonly rateLimiter = new BasicRateLimiter("thunderScansRateLimiter", {
    numberOfRequests: 5,
    bufferInterval: 3,
    ignoreImages: true,
  });
  private readonly cookieStorageInterceptor = new ThunderCookieInterceptor();
  private readonly interceptor = new ThunderInterceptor();

  constructor(private readonly client: ThunderClientContract = new ThunderClient()) {}

  async initialise(): Promise<void> {
    this.rateLimiter.registerInterceptor();
    this.cookieStorageInterceptor.registerInterceptor();
    this.interceptor.registerInterceptor();
  }

  async getSettingsForm(): Promise<Form> {
    return new ThunderSettingsForm(
      this.cookieStorageInterceptor,
      await fetchAccountStatus(this.cookieStorageInterceptor),
      () => this.client.invalidateAuthenticationCaches(),
    );
  }

  async cloudflareBypassCompleted(
    _request: Request,
    cookies: Cookie[],
    _localStorage: Record<string, string>,
  ): Promise<void> {
    persistThunderCookies(this.cookieStorageInterceptor, cookies);
    this.client.invalidateAuthenticationCaches();
  }

  async getDiscoverSections(): Promise<DiscoverSection[]> {
    return [
      {
        id: SECTIONS.POPULAR,
        title: "Popular today",
        type: DiscoverSectionType.featured,
      },
      {
        id: SECTIONS.EDITORS,
        title: "Editor’s picks",
        type: DiscoverSectionType.prominentCarousel,
      },
      {
        id: SECTIONS.LATEST_COMICS,
        title: "Latest comics",
        type: DiscoverSectionType.chapterUpdates,
      },
      {
        id: SECTIONS.LATEST_NOVELS,
        title: "Latest novels",
        type: DiscoverSectionType.chapterUpdates,
      },
      {
        id: SECTIONS.RECENTLY_ADDED,
        title: "Recently added",
        type: DiscoverSectionType.prominentCarousel,
      },
      {
        id: SECTIONS.GENRES,
        title: "Genres",
        type: DiscoverSectionType.genres,
      },
    ];
  }

  async getDiscoverSectionItems(
    section: DiscoverSection,
    metadata: PageMetadata | undefined,
  ): Promise<PagedResults<DiscoverSectionItem>> {
    if (section.id === SECTIONS.GENRES) {
      return {
        items: (await this.client.getGenres()).map((genre) => ({
          type: "genresCarouselItem",
          name: genre.title,
          searchQuery: {
            title: "",
            metadata: { genres: { [genre.id]: "included" } } satisfies ThunderSearchMetadata,
          },
          contentRating: contentRatingForTags([genre.title]),
        })),
      };
    }

    if (section.id === SECTIONS.RECENTLY_ADDED) {
      const page = metadata?.page ?? 1;
      const result = await this.client.getDirectoryPage(
        { title: "" },
        { id: "latest", label: "Recently added" },
        page,
      );
      return {
        items: prominentItems(result.items),
        ...(result.hasNextPage && { metadata: { page: page + 1 } }),
      };
    }

    const feed = (
      [
        SECTIONS.POPULAR,
        SECTIONS.EDITORS,
        SECTIONS.LATEST_COMICS,
        SECTIONS.LATEST_NOVELS,
      ] as string[]
    ).includes(section.id)
      ? (section.id as HomeFeedId)
      : undefined;
    if (!feed) return { items: [] };

    const result = await this.client.getHomeFeed(feed, metadata?.page);
    const items =
      feed === SECTIONS.POPULAR
        ? featuredItems(result.items)
        : feed === SECTIONS.EDITORS
          ? prominentItems(result.items)
          : updateItems(result.items);
    return {
      items,
      ...(result.nextPage !== undefined && { metadata: { page: result.nextPage } }),
    };
  }

  async getSortingOptions(query: SearchQuery<ThunderSearchMetadata>): Promise<SortingOption[]> {
    return query.title?.trim() ? [] : SORTING_OPTIONS.map((option) => ({ ...option }));
  }

  async getAdvancedSearchForm(
    query: SearchQuery<ThunderSearchMetadata>,
  ): Promise<AdvancedSearchForm> {
    return new ThunderAdvancedSearchForm(query, await this.client.getGenres());
  }

  async getSearchResults(
    query: SearchQuery<ThunderSearchMetadata>,
    metadata: PageMetadata | undefined,
    sortingOption?: SortingOption,
  ): Promise<PagedResults<SearchResultItem>> {
    const pasted = await this.client.resolvePastedUrl(query.title ?? "");
    if (pasted) return pasted;

    if (query.title?.trim() && hasAdvancedFilters(query.metadata)) {
      return {
        items: searchItems(await this.client.getAutocompleteResults(query.title, query.metadata)),
      };
    }

    const page = metadata?.page ?? 1;
    const result = await this.client.getDirectoryPage(query, sortingOption, page);
    return {
      items: searchItems(result.items),
      ...(result.hasNextPage && { metadata: { page: page + 1 } }),
    };
  }

  async getMangaDetails(mangaId: string): Promise<SourceManga> {
    return this.client.getMangaDetails(mangaId);
  }

  async getChapters(sourceManga: SourceManga): Promise<Chapter[]> {
    return this.client.getChapters(sourceManga, getShowLockedChapters());
  }

  async getChapterDetails(chapter: Chapter): Promise<ChapterDetails> {
    return this.client.getChapterDetails(chapter);
  }

  async processTitlesForUpdates(updateManager: UpdateManager): Promise<void> {
    const [comics, novels] = await Promise.all([
      this.client.getHomeFeed(SECTIONS.LATEST_COMICS),
      this.client.getHomeFeed(SECTIONS.LATEST_NOVELS),
    ]);
    const recentIds = new Set([...comics.items, ...novels.items].map((item) => item.mangaId));
    await Promise.all(
      updateManager
        .getQueuedItems()
        .map((manga) =>
          updateManager.setUpdatePriority(
            manga.mangaId,
            recentIds.has(manga.mangaId) ? "high" : "low",
          ),
        ),
    );
  }
}

/** Export name must match the folder ID for Paperback's generated test suite. */
export const Thunderscans = new ThunderScansExtension();
export { Thunderscans as ThunderScans };
