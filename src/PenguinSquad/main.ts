import {
  BasicRateLimiter,
  ContentRating,
  DiscoverSectionType,
  type Chapter,
  type ChapterDetails,
  type DiscoverSection,
  type DiscoverSectionItem,
  type ExtensionImpl,
  type MangaInfo,
  type PagedResults,
  type SearchQuery,
  type SearchResultItem,
  type SortingOption,
  type SourceManga,
} from "@paperback/types";

import { contentRatingForTags } from "../shared/html.js";
import { encodePaperbackIdComponent } from "../shared/ids.js";
import { PenguinClient } from "./client.js";
import { PenguinInterceptor } from "./interceptor.js";
import type {
  PenguinCard,
  PenguinCatalogPage,
  PenguinChapter,
  PenguinChapterRef,
  PenguinPageMetadata,
  PenguinReader,
  PenguinSeries,
  SeriesId,
} from "./models.js";
import {
  buildChapterUrl,
  buildSeriesUrl,
  decodeChapterId,
  decodeSeriesId,
  encodeSeriesId,
  normalizeSearchTerm,
  parsePageMetadata,
} from "./network.js";
import type PenguinSquadConfig from "./pbconfig.js";
import { SITE_ICON_URL } from "./site.js";

export interface PenguinSquadClientContract {
  getCatalogPage(page: number): Promise<PenguinCatalogPage>;
  search(term: string): Promise<PenguinCatalogPage>;
  getSeries(seriesId: SeriesId): Promise<PenguinSeries>;
  read(ref: PenguinChapterRef): Promise<PenguinReader>;
  resolvePastedUrl(value: string): Promise<PenguinSeries | undefined>;
  invalidateCaches(): void;
}

export const SECTIONS = {
  CATALOG: "catalog",
} as const;

const cardRating = (card: PenguinCard): ContentRating =>
  card.adult
    ? ContentRating.ADULT
    : contentRatingForTags(card.genre === undefined ? [] : [card.genre]);

const cardImage = (card: PenguinCard): string => card.coverUrl ?? SITE_ICON_URL;

const cardItem = (card: PenguinCard): SearchResultItem => ({
  mangaId: card.seriesId,
  title: card.title,
  imageUrl: cardImage(card),
  ...(card.genre && { subtitle: card.genre }),
  contentRating: cardRating(card),
});

const sectionItem = (card: PenguinCard): DiscoverSectionItem => ({
  type: "simpleCarouselItem",
  mangaId: card.seriesId,
  title: card.title,
  imageUrl: cardImage(card),
  ...(card.genre && { subtitle: card.genre }),
  contentRating: cardRating(card),
});

const cardFromSeries = (series: PenguinSeries): PenguinCard => ({
  seriesId: series.seriesId,
  title: series.title,
  ...(series.coverUrl && { coverUrl: series.coverUrl }),
  ...(series.tags[0] && { genre: series.tags[0] }),
  adult: series.adult,
});

const chapterTitle = (chapter: PenguinChapter): string => {
  if (chapter.access.kind === "public") return chapter.title;
  const label = chapter.access.kind === "locked" ? "🔒 Premium" : "🔒 Unverified access";
  return `${label} • ${chapter.title}`;
};

const mangaInfo = (series: PenguinSeries): MangaInfo => ({
  primaryTitle: series.title,
  secondaryTitles: series.originalTitle ? [series.originalTitle] : [],
  thumbnailUrl: series.coverUrl ?? SITE_ICON_URL,
  synopsis: series.synopsis,
  contentType: "novel",
  contentRating: series.adult ? ContentRating.ADULT : contentRatingForTags(series.tags),
  ...(series.status && { status: series.status }),
  ...(series.authors[0] && { author: series.authors[0] }),
  shareUrl: buildSeriesUrl(series.seriesId),
  ...((series.translator ?? series.originalTitle) && {
    additionalInfo: {
      ...(series.translator && { translator: series.translator }),
      ...(series.originalTitle && { originalTitle: series.originalTitle }),
    },
  }),
  ...(series.tags.length > 0 && {
    tagGroups: [
      {
        id: "genres",
        title: "Genres",
        tags: series.tags.map((tag) => ({ id: encodePaperbackIdComponent(tag), title: tag })),
      },
    ],
  }),
});

const sourceMangaId = (value: unknown): SeriesId => {
  try {
    if (typeof value !== "object" || value === null) throw new Error("invalid");
    const mangaId = (value as { mangaId?: unknown }).mangaId;
    if (typeof mangaId !== "string") throw new Error("invalid");
    return encodeSeriesId(decodeSeriesId(mangaId));
  } catch {
    throw new Error("Penguin Squad source manga is invalid.");
  }
};

const sectionId = (value: unknown): string | undefined => {
  try {
    if (typeof value !== "object" || value === null) return undefined;
    const id = (value as { id?: unknown }).id;
    return typeof id === "string" ? id : undefined;
  } catch {
    throw new Error("Penguin Squad discovery section is invalid.");
  }
};

const continuation = (
  page: PenguinCatalogPage,
  term?: string,
): { metadata?: PenguinPageMetadata } =>
  page.next === undefined
    ? {}
    : { metadata: term === undefined ? { page: page.next } : { page: page.next, query: term } };

export class PenguinSquadExtension implements ExtensionImpl<typeof PenguinSquadConfig> {
  private readonly rateLimiter = new BasicRateLimiter("penguinSquadRateLimiter", {
    numberOfRequests: 4,
    bufferInterval: 1,
    ignoreImages: true,
  });
  private readonly interceptor = new PenguinInterceptor();

  constructor(private readonly client: PenguinSquadClientContract = new PenguinClient()) {}

  async initialise(): Promise<void> {
    this.rateLimiter.registerInterceptor();
    this.interceptor.registerInterceptor();
  }

  async getDiscoverSections(): Promise<DiscoverSection[]> {
    return [
      {
        id: SECTIONS.CATALOG,
        title: "All novels",
        type: DiscoverSectionType.simpleCarousel,
      },
    ];
  }

  async getDiscoverSectionItems(
    section: DiscoverSection,
    metadata: PenguinPageMetadata | undefined,
  ): Promise<PagedResults<DiscoverSectionItem>> {
    if (sectionId(section) !== SECTIONS.CATALOG) return { items: [] };
    const { page } = parsePageMetadata(metadata);
    const catalog = await this.client.getCatalogPage(page);
    return { items: catalog.items.map(sectionItem), ...continuation(catalog) };
  }

  async getSearchResults(
    query: SearchQuery<PenguinPageMetadata>,
    metadata: PenguinPageMetadata | undefined,
    _sortingOption?: SortingOption,
  ): Promise<PagedResults<SearchResultItem>> {
    const term = normalizeSearchTerm(query.title);
    const pasted = term ? await this.client.resolvePastedUrl(query.title ?? "") : undefined;
    if (pasted) return { items: [cardItem(cardFromSeries(pasted))] };

    if (!term) {
      const { page } = parsePageMetadata(metadata);
      const catalog = await this.client.getCatalogPage(page);
      return { items: catalog.items.map(cardItem), ...continuation(catalog) };
    }

    const { page } = parsePageMetadata(metadata, { query: term });
    if (page !== 1) return { items: [] };
    const results = await this.client.search(term);
    return { items: results.items.map(cardItem), ...continuation(results, term) };
  }

  async getMangaDetails(mangaId: string): Promise<SourceManga> {
    const seriesId = encodeSeriesId(decodeSeriesId(mangaId));
    return { mangaId: seriesId, mangaInfo: mangaInfo(await this.client.getSeries(seriesId)) };
  }

  async getChapters(sourceManga: SourceManga, sinceDate?: Date): Promise<Chapter[]> {
    const seriesId = sourceMangaId(sourceManga);
    const series = await this.client.getSeries(seriesId);
    const since = sinceDate && !Number.isNaN(sinceDate.getTime()) ? sinceDate.getTime() : undefined;
    return series.chapters
      .filter(
        (chapter) =>
          since === undefined ||
          chapter.publishedAt === undefined ||
          chapter.publishedAt.getTime() > since,
      )
      .map((chapter, sortingIndex): Chapter => ({
        chapterId: chapter.chapterId,
        sourceManga,
        langCode: "en",
        chapNum: chapter.number,
        title: chapterTitle(chapter),
        ...(chapter.publishedAt && { publishDate: chapter.publishedAt }),
        sortingIndex,
        additionalInfo: { access: chapter.access.kind, url: buildChapterUrl(chapter.chapterId) },
      }));
  }

  async getChapterDetails(chapter: Chapter): Promise<ChapterDetails> {
    const ref = decodeChapterId(chapter.chapterId);
    if (sourceMangaId(chapter.sourceManga) !== ref.seriesId) {
      throw new Error("Penguin Squad chapter does not belong to this series.");
    }
    const reader = await this.client.read(ref);
    return { id: chapter.chapterId, mangaId: ref.seriesId, type: "html", html: reader.html };
  }
}

export const PenguinSquad = new PenguinSquadExtension();
