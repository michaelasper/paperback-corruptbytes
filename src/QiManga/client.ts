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

import { AsyncKeyedCache, utf8ByteLength } from "../shared/async-cache.js";
import { SourceHttpError } from "../shared/http.js";
import type { QiMangaSearchMetadata } from "./models.js";
import {
  buildBrowseUrl,
  buildChapterUrl,
  buildChaptersUrl,
  buildGenresUrl,
  buildHomeUrl,
  buildLatestUrl,
  buildSearchUrl,
  buildSeriesUrl,
  fetchText,
  normalizePageNumber,
  parseJsonDocument,
  parseSeriesUrl,
} from "./network.js";
import {
  finalizeChapters,
  parseChapterDetails,
  parseChapterPage,
  parseGenres,
  parseHome,
  parseMangaDetails,
  parseSeriesPage,
  type QiMangaChapterPage,
  type QiMangaHome,
  type QiMangaSeriesPage,
} from "./parsers.js";

// The live catalog includes Martial Peak at roughly 4,000 chapters (40 API pages).
// Keep that title complete while retaining a hard 10,000-chapter safety ceiling.
const MAX_CHAPTER_PAGES = 100;
const CHAPTER_PAGE_CONCURRENCY = 3;

const rawCache = (ttlMs: number, maxEntries: number, maxBytes: number) =>
  new AsyncKeyedCache<string, string>({
    ttlMs,
    maxEntries,
    maxBytes,
    weigh: utf8ByteLength,
  });

const searchItem = (manga: SourceManga): SearchResultItem => ({
  mangaId: manga.mangaId,
  title: manga.mangaInfo.primaryTitle,
  imageUrl: manga.mangaInfo.thumbnailUrl,
  contentRating: manga.mangaInfo.contentRating,
});

export class QiMangaClient {
  private readonly homeCache = rawCache(2 * 60_000, 1, 2 * 1_024 * 1_024);
  private readonly catalogCache = rawCache(30_000, 32, 8 * 1_024 * 1_024);
  private readonly seriesCache = rawCache(2 * 60_000, 24, 6 * 1_024 * 1_024);
  private readonly chapterListCache = rawCache(30_000, 64, 8 * 1_024 * 1_024);
  private readonly genreCache = rawCache(15 * 60_000, 1, 512 * 1_024);

  async getHome(): Promise<QiMangaHome> {
    const url = buildHomeUrl();
    return this.homeCache.getMapped(
      url,
      () => fetchText({ url, method: "GET" }),
      (body) => parseHome(parseJsonDocument<unknown>(body, url)),
    );
  }

  private getCatalogPage(url: string, expectedPage: number): Promise<QiMangaSeriesPage> {
    return this.catalogCache.getMapped(
      url,
      () => fetchText({ url, method: "GET" }),
      (body) => {
        const parsed = parseSeriesPage(parseJsonDocument<unknown>(body, url));
        if (parsed.page !== expectedPage) {
          throw new Error("Qi Manga returned the wrong catalog page.");
        }
        return parsed;
      },
    );
  }

  async getLatest(page: number): Promise<QiMangaSeriesPage> {
    const expectedPage = normalizePageNumber(page);
    return this.getCatalogPage(buildLatestUrl(expectedPage), expectedPage);
  }

  async getBrowsePage(
    query: SearchQuery<QiMangaSearchMetadata>,
    sortingOption: SortingOption | undefined,
    page: number,
  ): Promise<QiMangaSeriesPage> {
    const expectedPage = normalizePageNumber(page);
    return this.getCatalogPage(buildBrowseUrl(query, sortingOption, expectedPage), expectedPage);
  }

  async getSearchPage(
    query: SearchQuery<QiMangaSearchMetadata>,
    sortingOption: SortingOption | undefined,
    page: number,
  ): Promise<QiMangaSeriesPage> {
    return query.title?.trim()
      ? this.getTitleSearchPage(query, page)
      : this.getBrowsePage(query, sortingOption, page);
  }

  private async getTitleSearchPage(
    query: SearchQuery<QiMangaSearchMetadata>,
    page: number,
  ): Promise<QiMangaSeriesPage> {
    const expectedPage = normalizePageNumber(page);
    return this.getCatalogPage(buildSearchUrl(query, expectedPage), expectedPage);
  }

  async getGenres(): Promise<Tag[]> {
    const url = buildGenresUrl();
    return this.genreCache.getMapped(
      url,
      () => fetchText({ url, method: "GET" }),
      (body) => parseGenres(parseJsonDocument<unknown>(body, url)),
    );
  }

  async getMangaDetails(mangaId: string): Promise<SourceManga> {
    const url = buildSeriesUrl(mangaId);
    return this.seriesCache.getMapped(
      url,
      () => fetchText({ url, method: "GET" }),
      (body) => parseMangaDetails(parseJsonDocument<unknown>(body, url), mangaId),
    );
  }

  private async getChapterPage(
    sourceManga: SourceManga,
    page: number,
    showLocked: boolean,
  ): Promise<QiMangaChapterPage> {
    const expectedPage = normalizePageNumber(page);
    const url = buildChaptersUrl(sourceManga.mangaId, expectedPage, "asc");
    return this.chapterListCache.getMapped(
      url,
      () => fetchText({ url, method: "GET" }),
      (body) => {
        const parsed = parseChapterPage(
          parseJsonDocument<unknown>(body, url),
          sourceManga,
          showLocked,
        );
        if (parsed.page !== expectedPage) {
          throw new Error("Qi Manga returned the wrong chapter page.");
        }
        return parsed;
      },
    );
  }

  async getChapters(
    sourceManga: SourceManga,
    options: { showLocked?: boolean; sinceDate?: Date } = {},
  ): Promise<Chapter[]> {
    const showLocked = options.showLocked ?? true;
    const first = await this.getChapterPage(sourceManga, 1, showLocked);
    const pages = [first];
    let totalPages = first.pageCount;
    let nextPage = 2;

    while (nextPage <= totalPages) {
      if (totalPages > MAX_CHAPTER_PAGES) {
        throw new Error("Qi Manga returned too many chapter pages to process safely.");
      }
      const waveEnd = Math.min(totalPages, nextPage + CHAPTER_PAGE_CONCURRENCY - 1);
      const pageNumbers = Array.from(
        { length: waveEnd - nextPage + 1 },
        (_, index) => nextPage + index,
      );
      const parsedPages = await Promise.all(
        pageNumbers.map((page) => this.getChapterPage(sourceManga, page, showLocked)),
      );
      for (const parsed of parsedPages) {
        totalPages = Math.max(totalPages, parsed.pageCount);
        pages.push(parsed);
      }
      nextPage = waveEnd + 1;
    }

    if (totalPages > MAX_CHAPTER_PAGES) {
      throw new Error("Qi Manga returned too many chapter pages to process safely.");
    }
    const chapters = finalizeChapters(pages.flatMap((page) => page.chapters));
    const declaredCount = Math.max(0, ...pages.map((page) => page.totalCount ?? 0));
    if (showLocked && declaredCount > 0 && chapters.length < declaredCount) {
      throw new Error(
        `Qi Manga returned only ${chapters.length} of ${declaredCount} chapters; refusing to save a truncated list.`,
      );
    }

    const sinceDate = options.sinceDate;
    if (!sinceDate || Number.isNaN(sinceDate.getTime())) return chapters;
    return chapters.filter(
      (chapter) => !chapter.publishDate || chapter.publishDate.getTime() > sinceDate.getTime(),
    );
  }

  async getChapterDetails(chapter: Chapter): Promise<ChapterDetails> {
    const url = buildChapterUrl(chapter.sourceManga.mangaId, chapter.chapterId);
    const body = await fetchText({
      url,
      method: "GET",
      headers: { "cache-control": "no-store" },
    });
    return parseChapterDetails(parseJsonDocument<unknown>(body, url), chapter);
  }

  async resolvePastedUrl(query: string): Promise<PagedResults<SearchResultItem> | undefined> {
    const mangaId = parseSeriesUrl(query);
    if (!mangaId) return undefined;
    try {
      return { items: [searchItem(await this.getMangaDetails(mangaId))] };
    } catch (error: unknown) {
      if (error instanceof SourceHttpError && (error.status === 404 || error.status === 410)) {
        return undefined;
      }
      throw error;
    }
  }

  invalidateAccountCaches(): void {
    this.chapterListCache.clear();
  }

  invalidateCaches(): void {
    this.homeCache.clear();
    this.catalogCache.clear();
    this.seriesCache.clear();
    this.chapterListCache.clear();
    this.genreCache.clear();
  }
}
