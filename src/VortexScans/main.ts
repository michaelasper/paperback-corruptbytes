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
} from "@paperback/types";

import { fetchAccountStatus, persistVortexCookies } from "./auth.js";
import {
  fetchChapterContent,
  fetchChapterList,
  fetchGenres,
  fetchPostDetails,
  fetchSearchPage,
  resolveUrlQuery,
} from "./client.js";
import { VortexCookieInterceptor } from "./cookies.js";
import { VortexInterceptor } from "./interceptor.js";
import { PAGE_SIZE, type SearchMetadata } from "./network.js";
import {
  contentRatingForGenres,
  parseChapterDetails,
  parseChapterList,
  parseMangaDetails,
  parseMangaList,
} from "./parsers.js";
import type VortexScansConfig from "./pbconfig.js";
import { VortexAdvancedSearchForm } from "./search.js";
import { getShowLockedChapters, VortexSettingsForm } from "./settings.js";

export interface PageMetadata extends JSONObject {
  page?: number;
}

export const SECTIONS = {
  LATEST: "latest",
  POPULAR: "popular",
  NEW: "new",
  GENRES: "genres",
} as const;

export const SORTING_OPTIONS: SortingOption[] = [
  { id: "lastChapterAddedAt", label: "Recently updated" },
  { id: "totalViews", label: "Most viewed" },
  { id: "createdAt", label: "Recently added" },
  { id: "chaptersCount", label: "Chapter count" },
  { id: "postTitle", label: "Title" },
];

type SectionList = ReturnType<typeof parseMangaList>;

const nextPageMetadata = (
  totalCount: number | undefined,
  itemCount: number,
  page: number,
): PageMetadata | undefined => {
  const hasNext =
    typeof totalCount === "number" ? totalCount > page * PAGE_SIZE : itemCount >= PAGE_SIZE;
  return hasNext ? { page: page + 1 } : undefined;
};

const searchItems = (manga: SectionList): SearchResultItem[] =>
  manga.map((item) => ({
    mangaId: item.mangaId,
    title: item.title,
    imageUrl: item.imageUrl,
    subtitle: item.subtitle,
    contentRating: item.contentRating,
  }));

const popularItems = (manga: SectionList): DiscoverSectionItem[] =>
  manga.map((item) => {
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
      supertitle: item.author,
      infoItems:
        rating && status ? [rating, status] : rating ? [rating] : status ? [status] : undefined,
      contentRating: item.contentRating,
    };
  });

const latestItems = (manga: SectionList): DiscoverSectionItem[] =>
  manga.flatMap((item): DiscoverSectionItem[] =>
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

const newItems = (manga: SectionList): DiscoverSectionItem[] =>
  manga.map((item) => ({
    type: "prominentCarouselItem",
    mangaId: item.mangaId,
    title: item.title,
    imageUrl: item.imageUrl,
    subtitle: item.subtitle,
    contentRating: item.contentRating,
  }));

export class VortexScansExtension implements ExtensionImpl<typeof VortexScansConfig> {
  private readonly rateLimiter = new BasicRateLimiter("vortexScansRateLimiter", {
    numberOfRequests: 5,
    bufferInterval: 4,
    ignoreImages: true,
  });

  private readonly cookieStorageInterceptor = new VortexCookieInterceptor();
  private readonly interceptor = new VortexInterceptor();
  private genresPromise?: Promise<Tag[]>;

  async initialise(): Promise<void> {
    this.rateLimiter.registerInterceptor();
    this.cookieStorageInterceptor.registerInterceptor();
    this.interceptor.registerInterceptor();
  }

  async getSettingsForm(): Promise<Form> {
    return new VortexSettingsForm(
      this.cookieStorageInterceptor,
      await fetchAccountStatus(this.cookieStorageInterceptor),
    );
  }

  async cloudflareBypassCompleted(
    _request: Request,
    cookies: Cookie[],
    _localStorage: Record<string, string>,
  ): Promise<void> {
    this.genresPromise = undefined;
    persistVortexCookies(this.cookieStorageInterceptor, cookies);
  }

  async getDiscoverSections(): Promise<DiscoverSection[]> {
    return [
      {
        id: SECTIONS.LATEST,
        title: "Latest updates",
        type: DiscoverSectionType.chapterUpdates,
      },
      {
        id: SECTIONS.POPULAR,
        title: "Popular",
        type: DiscoverSectionType.featured,
      },
      {
        id: SECTIONS.NEW,
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
      const genres = await this.getGenres();
      return {
        items: genres.map((genre) => ({
          type: "genresCarouselItem",
          name: genre.title,
          searchQuery: {
            title: "",
            metadata: { genres: { [genre.id]: "included" } } satisfies SearchMetadata,
          },
          contentRating: contentRatingForGenres([genre.title]),
        })),
      };
    }

    if (
      section.id !== SECTIONS.LATEST &&
      section.id !== SECTIONS.POPULAR &&
      section.id !== SECTIONS.NEW
    ) {
      return { items: [] };
    }

    const page = metadata?.page ?? 1;
    const sortingId =
      section.id === SECTIONS.POPULAR
        ? "totalViews"
        : section.id === SECTIONS.NEW
          ? "createdAt"
          : "lastChapterAddedAt";
    const response = await fetchSearchPage(
      { title: "", metadata: { direction: ["desc"] } },
      { id: sortingId, label: sortingId },
      page,
    );
    const manga = parseMangaList(response);
    const items =
      section.id === SECTIONS.POPULAR
        ? popularItems(manga)
        : section.id === SECTIONS.NEW
          ? newItems(manga)
          : latestItems(manga);

    return {
      items,
      metadata: nextPageMetadata(response.totalCount, manga.length, page),
    };
  }

  async getSortingOptions(_query: SearchQuery<SearchMetadata>): Promise<SortingOption[]> {
    return SORTING_OPTIONS;
  }

  async getAdvancedSearchForm(query: SearchQuery<SearchMetadata>): Promise<AdvancedSearchForm> {
    return new VortexAdvancedSearchForm(query, await this.getGenres());
  }

  async getSearchResults(
    query: SearchQuery<SearchMetadata>,
    metadata: PageMetadata | undefined,
    sortingOption?: SortingOption,
  ): Promise<PagedResults<SearchResultItem>> {
    const pastedUrlResult = await resolveUrlQuery(query.title ?? "");
    if (pastedUrlResult) return pastedUrlResult;

    const page = metadata?.page ?? 1;
    const response = await fetchSearchPage(query, sortingOption, page);
    const manga = parseMangaList(response);
    return {
      items: searchItems(manga),
      metadata: nextPageMetadata(response.totalCount, manga.length, page),
    };
  }

  async getMangaDetails(mangaId: string): Promise<SourceManga> {
    const response = await fetchPostDetails(mangaId);
    return parseMangaDetails(response.post ?? response, mangaId);
  }

  async getChapters(sourceManga: SourceManga): Promise<Chapter[]> {
    const response = await fetchChapterList(sourceManga);
    return parseChapterList(response, sourceManga, {
      showLocked: getShowLockedChapters(),
    });
  }

  async getChapterDetails(chapter: Chapter): Promise<ChapterDetails> {
    return parseChapterDetails(await fetchChapterContent(chapter), chapter);
  }

  private getGenres(): Promise<Tag[]> {
    if (!this.genresPromise) {
      this.genresPromise = fetchGenres().catch((error: unknown) => {
        this.genresPromise = undefined;
        throw error;
      });
    }
    return this.genresPromise;
  }
}

export const VortexScans = new VortexScansExtension();
