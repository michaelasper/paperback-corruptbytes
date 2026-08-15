import type {
  Chapter,
  ChapterDetails,
  PagedResults,
  SearchQuery,
  SearchResultItem,
  SortingOption,
  SourceManga,
  Tag,
} from "@paperback/types";

import { AsyncKeyedCache, utf8ByteLength } from "./async-cache.js";
import type {
  NovelDashCatalogResponse,
  NovelDashSearchMetadata,
  NovelDashSite,
} from "./noveldash-models.js";
import {
  buildNovelDashCatalogUrl,
  buildNovelDashChapterUrl,
  buildNovelDashSeriesUrl,
  fetchNovelDashJson,
  fetchNovelDashText,
  parseNovelDashSeriesUrl,
} from "./noveldash-network.js";
import {
  parseNovelDashCatalog,
  parseNovelDashChapterDetails,
  parseNovelDashGenres,
  parseNovelDashSeriesPage,
  type ParsedNovelDashCatalog,
  type ParsedNovelDashSeriesPage,
} from "./noveldash-parsers.js";

const SERIES_PAGE_MAX_BYTES = 4 * 1_024 * 1_024;
const SERIES_CACHE_MAX_BYTES = 24 * 1_024 * 1_024;
const TAXONOMY_MAX_BYTES = 2 * 1_024 * 1_024;
const READER_MAX_BYTES = 8 * 1_024 * 1_024;
const MAX_CHAPTER_PAGES = 1_000;

const searchItem = (manga: SourceManga): SearchResultItem => ({
  mangaId: manga.mangaId,
  title: manga.mangaInfo.primaryTitle,
  imageUrl: manga.mangaInfo.thumbnailUrl,
  contentRating: manga.mangaInfo.contentRating,
});

export class NovelDashClient {
  private readonly seriesCache = new AsyncKeyedCache<string, string>({
    ttlMs: 60_000,
    maxEntries: 64,
    maxWeight: SERIES_CACHE_MAX_BYTES,
    weigh: utf8ByteLength,
  });
  private readonly taxonomyCache = new AsyncKeyedCache<"genres", string>({
    ttlMs: 15 * 60_000,
    maxEntries: 1,
    maxWeight: TAXONOMY_MAX_BYTES,
    weigh: utf8ByteLength,
  });

  constructor(readonly site: NovelDashSite) {}

  async getCatalogPage(
    query: SearchQuery<NovelDashSearchMetadata>,
    sortingOption: SortingOption | undefined,
    page: number,
    limit?: number,
  ): Promise<ParsedNovelDashCatalog> {
    const value = await fetchNovelDashJson<NovelDashCatalogResponse>(
      this.site,
      {
        url: buildNovelDashCatalogUrl(this.site, query, sortingOption, page, limit),
        method: "GET",
      },
      4 * 1_024 * 1_024,
    );
    return parseNovelDashCatalog(value, this.site);
  }

  async getGenres(): Promise<Tag[]> {
    return this.taxonomyCache.getMapped(
      "genres",
      () =>
        fetchNovelDashText(
          this.site,
          { url: `${this.site.domain}/series`, method: "GET" },
          TAXONOMY_MAX_BYTES,
        ),
      (html) => parseNovelDashGenres(html, this.site),
    );
  }

  async getMangaDetails(mangaId: string): Promise<SourceManga> {
    return (await this.getSeriesPage(mangaId, 1, { showLocked: false })).sourceManga;
  }

  async getChapters(
    sourceManga: SourceManga,
    options: { showLocked?: boolean; sinceDate?: Date } = {},
  ): Promise<Chapter[]> {
    const showLocked = options.showLocked ?? true;
    const first = await this.getSeriesPage(sourceManga.mangaId, 1, {
      showLocked,
      sourceManga,
    });
    const pages = [first];
    let totalPages = first.totalPages;
    for (let page = 2; page <= totalPages; page += 1) {
      if (page > MAX_CHAPTER_PAGES) {
        throw new Error(`${this.site.name} returned too many chapter pages to process safely.`);
      }
      const parsed = await this.getSeriesPage(sourceManga.mangaId, page, {
        showLocked,
        sourceManga,
      });
      if (parsed.currentPage !== page) {
        throw new Error(`${this.site.name} returned the wrong chapter page.`);
      }
      if (first.seriesId && parsed.seriesId && first.seriesId !== parsed.seriesId) {
        throw new Error(`${this.site.name} returned chapters for a different series.`);
      }
      totalPages = Math.max(totalPages, parsed.totalPages);
      pages.push(parsed);
    }

    const chapters = [
      ...new Map(
        pages.flatMap((page) => page.chapters).map((chapter) => [chapter.chapterId, chapter]),
      ).values(),
    ].sort((left, right) => {
      const numberDifference = left.chapNum - right.chapNum;
      if (numberDifference !== 0) return numberDifference;
      const dateDifference =
        (left.publishDate?.getTime() ?? 0) - (right.publishDate?.getTime() ?? 0);
      return dateDifference || left.chapterId.localeCompare(right.chapterId);
    });
    const declaredCount = Math.max(0, ...pages.map((page) => page.declaredChapterCount ?? 0));
    if (showLocked && declaredCount > 0 && chapters.length < declaredCount) {
      throw new Error(
        `${this.site.name} returned only ${chapters.length} of ${declaredCount} chapters; refusing to save a truncated list.`,
      );
    }
    const indexed = chapters.map((chapter, sortingIndex) => ({ ...chapter, sortingIndex }));
    const sinceDate = options.sinceDate;
    if (!sinceDate || Number.isNaN(sinceDate.getTime())) return indexed;
    return indexed.filter(
      (chapter) => !chapter.publishDate || chapter.publishDate.getTime() > sinceDate.getTime(),
    );
  }

  async getChapterDetails(chapter: Chapter): Promise<ChapterDetails> {
    const chapterNumber = chapter.additionalInfo?.number;
    if (!chapterNumber) throw new Error(`${this.site.name} chapter number is missing.`);
    const html = await fetchNovelDashText(
      this.site,
      {
        url: buildNovelDashChapterUrl(this.site, chapter.sourceManga.mangaId, chapterNumber),
        method: "GET",
        headers: { "cache-control": "no-store" },
      },
      READER_MAX_BYTES,
    );
    return parseNovelDashChapterDetails(html, chapter, this.site);
  }

  async resolvePastedUrl(query: string): Promise<PagedResults<SearchResultItem> | undefined> {
    const mangaId = parseNovelDashSeriesUrl(this.site, query);
    if (!mangaId) return undefined;
    try {
      return { items: [searchItem(await this.getMangaDetails(mangaId))] };
    } catch {
      return undefined;
    }
  }

  invalidateCaches(): void {
    this.seriesCache.clear();
    this.taxonomyCache.clear();
  }

  private async getSeriesPage(
    mangaId: string,
    page: number,
    options: { showLocked: boolean; sourceManga?: SourceManga },
  ): Promise<ParsedNovelDashSeriesPage> {
    const key = `${mangaId}:${page}`;
    return this.seriesCache.getMapped(
      key,
      () =>
        fetchNovelDashText(
          this.site,
          {
            url: buildNovelDashSeriesUrl(this.site, mangaId, page),
            method: "GET",
            headers: { "cache-control": "no-store" },
          },
          SERIES_PAGE_MAX_BYTES,
        ),
      (html) => parseNovelDashSeriesPage(html, this.site, mangaId, options),
    );
  }
}
