import type {
  Chapter,
  ChapterDetails,
  PagedResults,
  SearchQuery,
  SearchResultItem,
  SortingOption,
  SourceManga,
} from "@paperback/types";

import { AsyncKeyedCache, utf8ByteLength } from "../shared/async-cache.js";
import { isHttpsUrlForDomain, resolveHttpsUrl } from "../shared/url.js";
import type { MadaraCatalogPage, MadaraFilterOptions, MadaraSearchMetadata } from "./models.js";
import {
  DOMAIN,
  buildCatalogUrl,
  buildChapterAjaxRequests,
  buildMangaUrl,
  fetchText,
  fetchTextResponse,
  parseMangaUrl,
} from "./network.js";
import {
  parseCatalogPage,
  parseChapterDetails,
  parseChapters,
  parseFilterOptions,
  parseMangaDetails,
  parseNumericMangaId,
} from "./parsers.js";

const FILTERS_URL = `${DOMAIN}/?s=&post_type=wp-manga`;

const searchItem = (manga: SourceManga): SearchResultItem => ({
  mangaId: manga.mangaId,
  title: manga.mangaInfo.primaryTitle,
  imageUrl: manga.mangaInfo.thumbnailUrl,
  contentRating: manga.mangaInfo.contentRating,
});

const SERIES_CACHE_MAX_BYTES = 2 * 1_024 * 1_024;
const CHAPTER_CACHE_MAX_BYTES = 4 * 1_024 * 1_024;
const CATALOG_CACHE_MAX_BYTES = 2 * 1_024 * 1_024;
const FILTER_CACHE_MAX_BYTES = 1 * 1_024 * 1_024;

const canonicalPastedUrl = (value: string): string | undefined => {
  const match = value
    .trim()
    .match(/^https?:\/\/(?:www\.)?madaradex\.org(\/title\/[^/?#]+\/?)(?:[?#].*)?$/i);
  if (!match?.[1]) return undefined;
  return `${DOMAIN}${match[1].replace(/\/+$/, "")}/`;
};

const ajaxMarkup = (body: string): string => {
  const trimmed = body.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith('"')) return body;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed === "string") return parsed;
    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      for (const key of ["data", "html", "chapters"]) {
        if (typeof record[key] === "string") return record[key];
      }
    }
  } catch {
    // Treat non-JSON server text as HTML below.
  }
  return body;
};

export class MadaraDexClient {
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
  private readonly filterCache = new AsyncKeyedCache<"filters", string>({
    ttlMs: 15 * 60_000,
    maxEntries: 1,
    maxWeight: FILTER_CACHE_MAX_BYTES,
    weigh: utf8ByteLength,
  });

  async getCatalogPage(
    query: SearchQuery<MadaraSearchMetadata>,
    sortingOption: SortingOption | undefined,
    page: number,
  ): Promise<MadaraCatalogPage> {
    const url = buildCatalogUrl(query, sortingOption, page);
    return this.catalogCache.getMapped(
      url,
      () => fetchText({ url, method: "GET" }),
      parseCatalogPage,
    );
  }

  async getFilterOptions(): Promise<MadaraFilterOptions> {
    return this.filterCache.getMapped(
      "filters",
      () => fetchText({ url: FILTERS_URL, method: "GET" }),
      parseFilterOptions,
    );
  }

  async getMangaDetails(mangaId: string): Promise<SourceManga> {
    const key = `id:${mangaId}`;
    return this.seriesCache.getMapped(
      key,
      () => fetchText({ url: buildMangaUrl(mangaId), method: "GET" }),
      (html) => parseMangaDetails(html, mangaId),
    );
  }

  async getChapters(sourceManga: SourceManga, sinceDate?: Date): Promise<Chapter[]> {
    const seriesKey = `id:${sourceManga.mangaId}`;
    const inline = await this.seriesCache.getMapped(
      seriesKey,
      () => fetchText({ url: buildMangaUrl(sourceManga.mangaId), method: "GET" }),
      (html) => parseChapters(html, sourceManga),
    );
    const chapters =
      inline.length > 0
        ? inline
        : await this.chapterCache.getMapped(
            sourceManga.mangaId,
            () => this.fetchAjaxChapters(sourceManga),
            (html) => parseChapters(html, sourceManga),
          );
    if (!sinceDate || Number.isNaN(sinceDate.getTime())) return chapters;
    return chapters.filter(
      (chapter) => !chapter.publishDate || chapter.publishDate.getTime() > sinceDate.getTime(),
    );
  }

  async getChapterDetails(chapter: Chapter): Promise<ChapterDetails> {
    let url = resolveHttpsUrl(chapter.additionalInfo?.url, DOMAIN);
    if (!url || !isHttpsUrlForDomain(url, "madaradex.org")) {
      const current = (await this.getChapters(chapter.sourceManga)).find(
        (candidate) => candidate.chapterId === chapter.chapterId,
      );
      url = resolveHttpsUrl(current?.additionalInfo?.url, DOMAIN);
    }
    if (!url && /^chapter-[\p{L}\p{N}._~-]+$/u.test(chapter.chapterId)) {
      const shareUrl = resolveHttpsUrl(chapter.sourceManga.mangaInfo.shareUrl, DOMAIN);
      if (
        shareUrl &&
        isHttpsUrlForDomain(shareUrl, "madaradex.org") &&
        /^https:\/\/(?:www\.)?madaradex\.org\/title\/[^/?#]+\/$/i.test(shareUrl)
      ) {
        url = `${shareUrl}${chapter.chapterId}/`;
      }
    }
    if (!url || !isHttpsUrlForDomain(url, "madaradex.org")) {
      throw new Error(`MadaraDex could not resolve reader URL for ${chapter.chapterId}.`);
    }
    const html = await fetchText({ url, method: "GET" });
    return parseChapterDetails(html, {
      ...chapter,
      additionalInfo: { ...chapter.additionalInfo, url },
    });
  }

  async resolvePastedUrl(query: string): Promise<PagedResults<SearchResultItem> | undefined> {
    const numericId = parseMangaUrl(query);
    if (numericId) {
      try {
        return { items: [searchItem(await this.getMangaDetails(numericId))] };
      } catch {
        return undefined;
      }
    }

    const canonical = canonicalPastedUrl(query);
    if (!canonical) return undefined;
    try {
      return await this.seriesCache.getMapped(
        `url:${canonical}`,
        () => fetchText({ url: canonical, method: "GET" }),
        (html) => {
          const mangaId = parseNumericMangaId(html);
          if (!mangaId) throw new Error("MadaraDex canonical page did not contain a manga ID.");
          return { items: [searchItem(parseMangaDetails(html, mangaId))] };
        },
      );
    } catch {
      return undefined;
    }
  }

  invalidateCaches(): void {
    this.seriesCache.clear();
    this.chapterCache.clear();
    this.catalogCache.clear();
    this.filterCache.clear();
  }

  private async fetchAjaxChapters(sourceManga: SourceManga): Promise<string> {
    for (const request of buildChapterAjaxRequests(sourceManga.mangaId)) {
      const { response, body } = await fetchTextResponse(request);
      if (response.status < 200 || response.status >= 300) continue;
      const markup = ajaxMarkup(body);
      if (parseChapters(markup, sourceManga).length > 0) return markup;
    }
    throw new Error("MadaraDex returned no chapters from inline or AJAX endpoints.");
  }
}
