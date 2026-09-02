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
  type Tag,
} from "@paperback/types";

import { contentRatingForTags } from "../shared/html.js";
import {
  fetchQiMangaAccountStatus,
  fetchQiMangaTextWithSessionRefresh,
  persistQiMangaCookies,
  type QiMangaCookieStore,
} from "./auth.js";
import { QiMangaClient } from "./client.js";
import { QiMangaCookieInterceptor } from "./cookies.js";
import { QiMangaInterceptor } from "./interceptor.js";
import type { QiMangaCard, QiMangaPageMetadata, QiMangaSearchMetadata } from "./models.js";
import type { QiMangaHome, QiMangaSeriesPage } from "./parsers.js";
import type QiMangaConfig from "./pbconfig.js";
import { QiMangaAdvancedSearchForm } from "./search.js";
import { getShowLockedChapters, QiMangaSettingsForm } from "./settings.js";

export interface QiMangaClientContract {
  getHome(): Promise<QiMangaHome>;
  getLatest(page: number): Promise<QiMangaSeriesPage>;
  getSearchPage(
    query: SearchQuery<QiMangaSearchMetadata>,
    sortingOption: SortingOption | undefined,
    page: number,
  ): Promise<QiMangaSeriesPage>;
  getGenres(): Promise<Tag[]>;
  getMangaDetails(mangaId: string): Promise<SourceManga>;
  getChapters(
    sourceManga: SourceManga,
    options?: { showLocked?: boolean; sinceDate?: Date },
  ): Promise<Chapter[]>;
  getChapterDetails(chapter: Chapter): Promise<ChapterDetails>;
  resolvePastedUrl(query: string): Promise<PagedResults<SearchResultItem> | undefined>;
  invalidateAccountCaches(): void;
  invalidateCaches(): void;
}

export const SECTIONS = {
  FEATURED: "featured",
  POPULAR: "popular",
  PINNED: "pinned",
  LATEST: "latest",
  EDITORS_PICK: "editorsPick",
  NEW_SERIES: "newSeries",
  GENRES: "genres",
} as const;

export const SORTING_OPTIONS: SortingOption[] = [
  { id: "latest", label: "Latest updated" },
  { id: "newest", label: "Newest" },
  { id: "popular", label: "Popular" },
  { id: "alphabetical", label: "Title: A–Z" },
];

const displayLabel = (value: string | undefined): string | undefined => {
  const words = value
    ?.trim()
    .toLowerCase()
    .split(/[_\s-]+/)
    .filter(Boolean);
  return words?.length
    ? words.map((word) => `${word[0]?.toUpperCase()}${word.slice(1)}`).join(" ")
    : undefined;
};

const subtitle = (item: QiMangaCard): string | undefined => {
  const values = [
    displayLabel(item.type),
    displayLabel(item.status),
    item.rating !== undefined ? `★ ${(item.rating * 5).toFixed(1)}` : undefined,
  ].filter((value): value is string => Boolean(value));
  return values.length > 0 ? values.join(" · ") : undefined;
};

const searchItems = (page: QiMangaSeriesPage): SearchResultItem[] =>
  page.items.map((item) => ({
    mangaId: item.mangaId,
    title: item.title,
    imageUrl: item.imageUrl,
    subtitle: subtitle(item),
    contentRating: item.contentRating,
  }));

const sectionItems = (
  items: QiMangaCard[],
  type: "featuredCarouselItem" | "prominentCarouselItem" | "simpleCarouselItem",
): DiscoverSectionItem[] =>
  items.map((item) => {
    if (type === "featuredCarouselItem") {
      const infoItems: FeaturedCarouselItem["infoItems"] =
        item.rating === undefined
          ? undefined
          : [{ symbol: "star.fill", text: (item.rating * 5).toFixed(1) }];
      const supertitle = [displayLabel(item.type), displayLabel(item.status)]
        .filter((value): value is string => Boolean(value))
        .join(" · ");
      return {
        type,
        mangaId: item.mangaId,
        title: item.title,
        imageUrl: item.imageUrl,
        ...(supertitle && { supertitle }),
        ...(infoItems && { infoItems }),
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

const nextPage = (page: QiMangaSeriesPage): QiMangaPageMetadata | undefined =>
  page.page < page.pageCount ? { page: page.page + 1 } : undefined;

export class QiMangaExtension implements ExtensionImpl<typeof QiMangaConfig> {
  private readonly rateLimiter = new BasicRateLimiter("qiMangaRateLimiter", {
    numberOfRequests: 4,
    bufferInterval: 1,
    ignoreImages: true,
  });
  private readonly cookies: QiMangaCookieStore & QiMangaCookieInterceptor =
    new QiMangaCookieInterceptor();
  private readonly interceptor = new QiMangaInterceptor();
  private readonly client: QiMangaClientContract;

  constructor(client?: QiMangaClientContract) {
    this.client =
      client ??
      new QiMangaClient((request) => fetchQiMangaTextWithSessionRefresh(this.cookies, request));
  }

  async initialise(): Promise<void> {
    this.rateLimiter.registerInterceptor();
    this.cookies.registerInterceptor();
    this.interceptor.registerInterceptor();
  }

  async getSettingsForm(): Promise<Form> {
    const account = await fetchQiMangaAccountStatus(this.cookies);
    this.client.invalidateAccountCaches();
    return new QiMangaSettingsForm(this.cookies, account, () =>
      this.client.invalidateAccountCaches(),
    );
  }

  async cloudflareBypassCompleted(
    _request: Request,
    cookies: Cookie[],
    _localStorage: Record<string, string>,
  ): Promise<void> {
    persistQiMangaCookies(this.cookies, cookies);
    this.client.invalidateCaches();
  }

  async getDiscoverSections(): Promise<DiscoverSection[]> {
    return [
      { id: SECTIONS.FEATURED, title: "Featured", type: DiscoverSectionType.featured },
      { id: SECTIONS.POPULAR, title: "Popular today", type: DiscoverSectionType.simpleCarousel },
      {
        id: SECTIONS.PINNED,
        title: "Pinned series",
        type: DiscoverSectionType.prominentCarousel,
      },
      { id: SECTIONS.LATEST, title: "Latest updates", type: DiscoverSectionType.simpleCarousel },
      {
        id: SECTIONS.EDITORS_PICK,
        title: "Editors' picks",
        type: DiscoverSectionType.prominentCarousel,
      },
      {
        id: SECTIONS.NEW_SERIES,
        title: "New series",
        type: DiscoverSectionType.prominentCarousel,
      },
      { id: SECTIONS.GENRES, title: "Genres", type: DiscoverSectionType.genres },
    ];
  }

  async getDiscoverSectionItems(
    section: DiscoverSection,
    metadata: QiMangaPageMetadata | undefined,
  ): Promise<PagedResults<DiscoverSectionItem>> {
    if (section.id === SECTIONS.GENRES) {
      return {
        items: (await this.client.getGenres()).map((genre) => ({
          type: "genresCarouselItem",
          name: genre.title,
          searchQuery: {
            title: "",
            metadata: { genre: genre.id } satisfies QiMangaSearchMetadata,
          },
          contentRating: contentRatingForTags([genre.title]),
        })),
      };
    }
    if (section.id === SECTIONS.LATEST) {
      const page = await this.client.getLatest(metadata?.page ?? 1);
      return {
        items: sectionItems(page.items, "simpleCarouselItem"),
        metadata: nextPage(page),
      };
    }

    const home = await this.client.getHome();
    const configuration = {
      [SECTIONS.FEATURED]: [home.banners, "featuredCarouselItem"],
      [SECTIONS.POPULAR]: [home.popular, "simpleCarouselItem"],
      [SECTIONS.PINNED]: [home.pinned, "prominentCarouselItem"],
      [SECTIONS.EDITORS_PICK]: [home.editorsPick, "prominentCarouselItem"],
      [SECTIONS.NEW_SERIES]: [home.newSeries, "prominentCarouselItem"],
    } as const;
    const selected = configuration[section.id as keyof typeof configuration];
    return selected ? { items: sectionItems(selected[0], selected[1]) } : { items: [] };
  }

  async getSortingOptions(_query: SearchQuery<QiMangaSearchMetadata>): Promise<SortingOption[]> {
    return SORTING_OPTIONS.map((option) => ({ ...option }));
  }

  async getAdvancedSearchForm(
    query: SearchQuery<QiMangaSearchMetadata>,
  ): Promise<AdvancedSearchForm> {
    return new QiMangaAdvancedSearchForm(query, await this.client.getGenres());
  }

  async getSearchResults(
    query: SearchQuery<QiMangaSearchMetadata>,
    metadata: QiMangaPageMetadata | undefined,
    sortingOption?: SortingOption,
  ): Promise<PagedResults<SearchResultItem>> {
    const pasted = await this.client.resolvePastedUrl(query.title ?? "");
    if (pasted) return pasted;
    const page = await this.client.getSearchPage(query, sortingOption, metadata?.page ?? 1);
    return { items: searchItems(page), metadata: nextPage(page) };
  }

  async getMangaDetails(mangaId: string): Promise<SourceManga> {
    return this.client.getMangaDetails(mangaId);
  }

  async getChapters(sourceManga: SourceManga, sinceDate?: Date): Promise<Chapter[]> {
    return this.client.getChapters(sourceManga, {
      showLocked: getShowLockedChapters(),
      ...(sinceDate && { sinceDate }),
    });
  }

  async getChapterDetails(chapter: Chapter): Promise<ChapterDetails> {
    return this.client.getChapterDetails(chapter);
  }
}

export const QiManga = new QiMangaExtension();
