import type {
  Chapter,
  ChapterDetails,
  PagedResults,
  SearchResultItem,
  SourceManga,
} from "@paperback/types";

import { AsyncKeyedCache, utf8ByteLength } from "../shared/async-cache.js";
import { isHttpsUrlForDomain, resolveHttpsUrl } from "../shared/url.js";
import type { RokariCatalogPage, RokariFilterOptions } from "./models.js";
import {
  DOMAIN,
  buildCatalogUrl,
  buildChapterUrl,
  buildGenreUrl,
  buildMangaUrl,
  buildSearchUrl,
  fetchText,
  parseChapterUrl,
  parseMangaUrl,
} from "./network.js";
import {
  parseCatalogCards,
  parseChapterDetails,
  parseChapters,
  parseFilterOptions,
  parseMangaDetails,
  parseSearchCards,
} from "./parsers.js";

const SERIES_CACHE_MAX_BYTES = 4 * 1_024 * 1_024;
const CHAPTER_CACHE_MAX_BYTES = 4 * 1_024 * 1_024;
const CATALOG_CACHE_MAX_BYTES = 4 * 1_024 * 1_024;
const FILTER_CACHE_MAX_BYTES = 1 * 1_024 * 1_024;

const searchItem = (manga: SourceManga): SearchResultItem => ({
  mangaId: manga.mangaId,
  title: manga.mangaInfo.primaryTitle,
  imageUrl: manga.mangaInfo.thumbnailUrl,
  contentRating: manga.mangaInfo.contentRating,
});

export class RokariClient {
  private readonly seriesCache = new AsyncKeyedCache<string, string>({
    ttlMs: 180_000,
    maxEntries: 128,
    maxWeight: SERIES_CACHE_MAX_BYTES,
    weigh: utf8ByteLength,
  });
  private readonly chapterCache = new AsyncKeyedCache<string, string>({
    ttlMs: 60_000,
    maxEntries: 64,
    maxWeight: CHAPTER_CACHE_MAX_BYTES,
    weigh: utf8ByteLength,
  });
  private readonly catalogCache = new AsyncKeyedCache<string, string>({
    ttlMs: 60_000,
    maxEntries: 32,
    maxWeight: CATALOG_CACHE_MAX_BYTES,
    weigh: utf8ByteLength,
  });
  private readonly filterCache = new AsyncKeyedCache<"filters", string>({
    ttlMs: 30 * 60_000,
    maxEntries: 1,
    maxWeight: FILTER_CACHE_MAX_BYTES,
    weigh: utf8ByteLength,
  });

  private seriesHtml(mangaId: string): Promise<string> {
    const url = buildMangaUrl(mangaId);
    return this.seriesCache.get(url, () => fetchText({ url, method: "GET" }));
  }

  async getCatalogPage(order: "update" | "popular" = "update"): Promise<RokariCatalogPage> {
    const url = buildCatalogUrl(order);
    return this.catalogCache.getMapped(
      url,
      () => fetchText({ url, method: "GET" }),
      parseCatalogCards,
    );
  }

  async searchComics(term: string): Promise<RokariCatalogPage> {
    const url = buildSearchUrl(term);
    return this.catalogCache.getMapped(
      url,
      () => fetchText({ url, method: "GET" }),
      parseSearchCards,
    );
  }

  async getFilterOptions(): Promise<RokariFilterOptions> {
    return this.filterCache.getMapped(
      "filters",
      () => fetchText({ url: buildCatalogUrl("update"), method: "GET" }),
      parseFilterOptions,
    );
  }

  async getGenrePage(slug: string): Promise<RokariCatalogPage> {
    const url = buildGenreUrl(slug);
    return this.catalogCache.getMapped(url, () => fetchText({ url, method: "GET" }), parseCatalogCards);
  }

  async getMangaDetails(mangaId: string): Promise<SourceManga> {
    const html = await this.seriesHtml(mangaId);
    return parseMangaDetails(html, mangaId);
  }

  async getChapters(sourceManga: SourceManga, sinceDate?: Date): Promise<Chapter[]> {
    const html = await this.seriesHtml(sourceManga.mangaId);
    const chapters = parseChapters(html, sourceManga);
    if (!sinceDate || Number.isNaN(sinceDate.getTime())) return chapters;
    return chapters.filter(
      (chapter) => !chapter.publishDate || chapter.publishDate.getTime() > sinceDate.getTime(),
    );
  }

  async getChapterDetails(chapter: Chapter): Promise<ChapterDetails> {
    let url = resolveHttpsUrl(chapter.additionalInfo?.url, DOMAIN);
    if (!url || !isHttpsUrlForDomain(url, "rokaricomics.com")) {
      url = buildChapterUrl(chapter.chapterId);
    }
    const html = await fetchText({ url, method: "GET" });
    return parseChapterDetails(html, {
      ...chapter,
      additionalInfo: { ...chapter.additionalInfo, url },
    });
  }

  async getDetailsAndChapters(
    mangaId: string,
    sinceDate?: Date,
  ): Promise<{ manga: SourceManga; chapters: Chapter[] }> {
    const html = await this.seriesHtml(mangaId);
    const manga = parseMangaDetails(html, mangaId);
    const chapters = parseChapters(html, manga);
    if (!sinceDate || Number.isNaN(sinceDate.getTime())) return { manga, chapters };
    return {
      manga,
      chapters: chapters.filter(
        (chapter) => !chapter.publishDate || chapter.publishDate.getTime() > sinceDate.getTime(),
      ),
    };
  }

  async resolvePastedUrl(query: string): Promise<PagedResults<SearchResultItem> | undefined> {
    const mangaId = parseMangaUrl(query);
    if (mangaId) {
      try {
        return { items: [searchItem(await this.getMangaDetails(mangaId))] };
      } catch {
        return undefined;
      }
    }
    const chapterId = parseChapterUrl(query);
    if (chapterId) {
      const seriesSlug = chapterId.replace(/-chapter-\d+(?:\.\d+)?$/i, "");
      if (seriesSlug && seriesSlug !== chapterId) {
        try {
          return { items: [searchItem(await this.getMangaDetails(seriesSlug))] };
        } catch {
          return undefined;
        }
      }
    }
    return undefined;
  }

  invalidateCaches(): void {
    this.seriesCache.clear();
    this.chapterCache.clear();
    this.catalogCache.clear();
    this.filterCache.clear();
  }
}
