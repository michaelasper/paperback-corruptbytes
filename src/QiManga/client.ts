import type {
  Chapter,
  ChapterDetails,
  PagedResults,
  Request,
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
  CATALOG_PAGE_SIZE,
  buildBrowseUrl,
  buildChapterUrl,
  buildChaptersUrl,
  buildGenresUrl,
  buildHomeUrl,
  buildLatestUrl,
  buildSearchUrl,
  buildSeriesUrl,
  fetchText,
  hasTitleSearchQuery,
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
const MAX_TOTAL_CHAPTERS = MAX_CHAPTER_PAGES * CATALOG_PAGE_SIZE;
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

export type QiMangaTextFetcher = (request: Request) => Promise<string>;
export type QiMangaAuthenticationGeneration = () => number;

const AUTHENTICATION_CHANGED_ERROR =
  "Qi Manga authentication changed while this response was loading. Please try again.";

export class QiMangaClient {
  private readonly homeCache = rawCache(2 * 60_000, 1, 2 * 1_024 * 1_024);
  private readonly catalogCache = rawCache(30_000, 32, 8 * 1_024 * 1_024);
  private readonly seriesCache = rawCache(2 * 60_000, 24, 6 * 1_024 * 1_024);
  private readonly chapterListCache = rawCache(30_000, 64, 8 * 1_024 * 1_024);
  private readonly genreCache = rawCache(15 * 60_000, 1, 512 * 1_024);

  constructor(
    private readonly fetchTextRequest: QiMangaTextFetcher = fetchText,
    private readonly getAuthenticationGeneration: QiMangaAuthenticationGeneration = () => 0,
  ) {}

  private authenticationGeneration(): number {
    try {
      const generation = this.getAuthenticationGeneration();
      if (Number.isSafeInteger(generation) && generation >= 0) return generation;
    } catch {
      // Runtime callbacks can violate their static contract.
    }
    throw new Error(AUTHENTICATION_CHANGED_ERROR);
  }

  private assertAuthenticationGeneration(expected: number): void {
    if (this.authenticationGeneration() !== expected) {
      throw new Error(AUTHENTICATION_CHANGED_ERROR);
    }
  }

  private async fetchForAuthentication(request: Request, expected: number): Promise<string> {
    this.assertAuthenticationGeneration(expected);
    const body = await this.fetchTextRequest(request);
    this.assertAuthenticationGeneration(expected);
    return body;
  }

  async getHome(): Promise<QiMangaHome> {
    const url = buildHomeUrl();
    return this.homeCache.getMapped(
      url,
      () => this.fetchTextRequest({ url, method: "GET" }),
      (body) => parseHome(parseJsonDocument<unknown>(body, url)),
    );
  }

  private getCatalogPage(url: string, expectedPage: number): Promise<QiMangaSeriesPage> {
    return this.catalogCache.getMapped(
      url,
      () => this.fetchTextRequest({ url, method: "GET" }),
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
    return hasTitleSearchQuery(query.title)
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
      () => this.fetchTextRequest({ url, method: "GET" }),
      (body) => parseGenres(parseJsonDocument<unknown>(body, url)),
    );
  }

  async getMangaDetails(mangaId: string): Promise<SourceManga> {
    const url = buildSeriesUrl(mangaId);
    return this.seriesCache.getMapped(
      url,
      () => this.fetchTextRequest({ url, method: "GET" }),
      (body) => parseMangaDetails(parseJsonDocument<unknown>(body, url), mangaId),
    );
  }

  private async getChapterPage(
    sourceManga: SourceManga,
    page: number,
    authenticationGeneration: number,
  ): Promise<QiMangaChapterPage> {
    this.assertAuthenticationGeneration(authenticationGeneration);
    const expectedPage = normalizePageNumber(page);
    const url = buildChaptersUrl(sourceManga.mangaId, expectedPage, "asc");
    const cacheKey = `${authenticationGeneration}:${url}`;
    const parsed = await this.chapterListCache.getMapped(
      cacheKey,
      () => this.fetchForAuthentication({ url, method: "GET" }, authenticationGeneration),
      (body) => {
        const pageResult = parseChapterPage(
          parseJsonDocument<unknown>(body, url),
          sourceManga,
          true,
        );
        if (pageResult.page !== expectedPage) {
          throw new Error("Qi Manga returned the wrong chapter page.");
        }
        return pageResult;
      },
    );
    this.assertAuthenticationGeneration(authenticationGeneration);
    return parsed;
  }

  async getChapters(
    sourceManga: SourceManga,
    options: { showLocked?: boolean; sinceDate?: Date } = {},
  ): Promise<Chapter[]> {
    const showLocked = typeof options.showLocked === "boolean" ? options.showLocked : true;
    const authenticationGeneration = this.authenticationGeneration();
    const first = await this.getChapterPage(sourceManga, 1, authenticationGeneration);
    if (first.totalCount > MAX_TOTAL_CHAPTERS) {
      throw new Error("Qi Manga returned too many chapters to process safely.");
    }
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
        pageNumbers.map((page) => this.getChapterPage(sourceManga, page, authenticationGeneration)),
      );
      for (const parsed of parsedPages) {
        if (parsed.totalCount > MAX_TOTAL_CHAPTERS) {
          throw new Error("Qi Manga returned too many chapters to process safely.");
        }
        if (parsed.pageCount !== totalPages) {
          throw new Error("Qi Manga returned inconsistent declared chapter pagination.");
        }
        pages.push(parsed);
      }
      nextPage = waveEnd + 1;
    }

    if (totalPages > MAX_CHAPTER_PAGES) {
      throw new Error("Qi Manga returned too many chapter pages to process safely.");
    }
    const chapters = finalizeChapters(pages.flatMap((page) => page.chapters));
    const declaredCounts = new Set(pages.map((page) => page.totalCount));
    if (declaredCounts.size > 1) {
      throw new Error("Qi Manga returned inconsistent declared chapter totals.");
    }
    const declaredCount = declaredCounts.values().next().value as number;
    if (chapters.length !== declaredCount) {
      if (chapters.length < declaredCount) {
        throw new Error(
          `Qi Manga returned only ${chapters.length} of ${declaredCount} chapters; refusing to save a truncated list.`,
        );
      }
      throw new Error(
        `Qi Manga returned ${chapters.length} distinct chapters for a declared total of ${declaredCount}.`,
      );
    }
    this.assertAuthenticationGeneration(authenticationGeneration);

    const visibleChapters = showLocked
      ? chapters
      : chapters.filter((chapter) => chapter.additionalInfo?.locked === "false");
    const sinceDate = options.sinceDate;
    let sinceTime = Number.NaN;
    if (sinceDate instanceof Date) {
      try {
        sinceTime = Date.prototype.getTime.call(sinceDate) as number;
      } catch {
        // Runtime bridge values can violate their static Date declaration.
      }
    }
    if (!Number.isFinite(sinceTime)) return visibleChapters;
    return visibleChapters.filter((chapter) => {
      if (!chapter.publishDate) return true;
      try {
        const publishTime = Date.prototype.getTime.call(chapter.publishDate) as number;
        return !Number.isFinite(publishTime) || publishTime > sinceTime;
      } catch {
        return true;
      }
    });
  }

  async getChapterDetails(chapter: Chapter): Promise<ChapterDetails> {
    const authenticationGeneration = this.authenticationGeneration();
    const url = buildChapterUrl(chapter.sourceManga.mangaId, chapter.chapterId);
    const body = await this.fetchForAuthentication(
      {
        url,
        method: "GET",
        headers: { "cache-control": "no-store" },
      },
      authenticationGeneration,
    );
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
