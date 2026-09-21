import type {
  Chapter,
  ChapterDetails,
  PagedResults,
  SearchResultItem,
  SourceManga,
} from "@paperback/types";

import { AsyncKeyedCache, utf8ByteLength } from "../shared/async-cache.js";
import { isHttpsUrlForDomain, resolveHttpsUrl } from "../shared/url.js";
import type { TempleCatalogPage } from "./models.js";
import {
  DOMAIN,
  buildCatalogUrl,
  buildChapterUrl,
  buildMangaUrl,
  buildSearchUrl,
  fetchJson,
  fetchText,
  parseChapterUrl,
  parseMangaUrl,
} from "./network.js";
import {
  parseChapterDetails,
  parseChapters,
  parseComicsCards,
  parseMangaDetails,
  parseSearchResponse,
} from "./parsers.js";

const SERIES_CACHE_MAX_BYTES = 2 * 1_024 * 1_024;
const CHAPTER_CACHE_MAX_BYTES = 4 * 1_024 * 1_024;
const CATALOG_CACHE_MAX_BYTES = 2 * 1_024 * 1_024;

const searchItem = (manga: SourceManga): SearchResultItem => ({
  mangaId: manga.mangaId,
  title: manga.mangaInfo.primaryTitle,
  imageUrl: manga.mangaInfo.thumbnailUrl,
  contentRating: manga.mangaInfo.contentRating,
});

export class TempleClient {
  private readonly seriesCache = new AsyncKeyedCache<string, string>({
    ttlMs: 120_000,
    maxEntries: 64,
    maxWeight: SERIES_CACHE_MAX_BYTES,
    weigh: utf8ByteLength,
  });
  private readonly chapterCache = new AsyncKeyedCache<string, string>({
    ttlMs: 30_000,
    maxEntries: 48,
    maxWeight: CHAPTER_CACHE_MAX_BYTES,
    weigh: utf8ByteLength,
  });
  private readonly catalogCache = new AsyncKeyedCache<string, string>({
    ttlMs: 45_000,
    maxEntries: 24,
    maxWeight: CATALOG_CACHE_MAX_BYTES,
    weigh: utf8ByteLength,
  });

  async getCatalogPage(page: number): Promise<TempleCatalogPage> {
    void page;
    return this.catalogCache.getMapped(
      buildCatalogUrl(),
      () => fetchText({ url: buildCatalogUrl(), method: "GET" }),
      parseComicsCards,
    );
  }

  async searchComics(term: string, page: number): Promise<TempleCatalogPage> {
    const raw = await fetchJson<unknown>({ url: buildSearchUrl(term, page), method: "GET" });
    return parseSearchResponse(raw);
  }

  async getMangaDetails(mangaId: string): Promise<SourceManga> {
    const key = `manga:${mangaId}`;
    return this.seriesCache.getMapped(
      key,
      () => fetchText({ url: buildMangaUrl(mangaId), method: "GET" }),
      (html) => parseMangaDetails(html, mangaId),
    );
  }

  async getChapters(sourceManga: SourceManga, sinceDate?: Date): Promise<Chapter[]> {
    const key = `chapters:${sourceManga.mangaId}`;
    const chapters = await this.chapterCache.getMapped(
      key,
      () => fetchText({ url: buildMangaUrl(sourceManga.mangaId), method: "GET" }),
      (html) => parseChapters(html, sourceManga),
    );
    if (!sinceDate || Number.isNaN(sinceDate.getTime())) return chapters;
    return chapters.filter(
      (chapter) => !chapter.publishDate || chapter.publishDate.getTime() > sinceDate.getTime(),
    );
  }

  async getChapterDetails(chapter: Chapter): Promise<ChapterDetails> {
    let url = resolveHttpsUrl(chapter.additionalInfo?.url, DOMAIN);
    if (!url || !isHttpsUrlForDomain(url, "templetoons.com")) {
      url = buildChapterUrl(chapter.chapterId);
    }
    const html = await fetchText({ url, method: "GET" });
    return parseChapterDetails(html, {
      ...chapter,
      additionalInfo: { ...chapter.additionalInfo, url },
    });
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
  }
}
