import type {
  Chapter,
  ChapterDetails,
  PagedResults,
  SearchQuery,
  SearchResultItem,
  SortingOption,
  SourceManga,
} from "@paperback/types";

import { AsyncKeyedCache } from "../shared/async-cache.js";
import type {
  MgekoBrowseEnvelope,
  MgekoCard,
  MgekoFilterOptions,
  MgekoSearchMetadata,
} from "./models.js";
import {
  DOMAIN,
  buildBrowseUrl,
  buildChapterUrl,
  buildChaptersUrl,
  buildMangaUrl,
  fetchJson,
  fetchText,
  parseMangaUrl,
} from "./network.js";
import {
  parseBrowseCards,
  parseBrowseResponse,
  parseChapterDetails,
  parseChapters,
  parseFilterOptions,
  parseMangaDetails,
} from "./parsers.js";

export type MgekoBrowsePage = MgekoBrowseEnvelope & { items: MgekoCard[] };

const searchItem = (manga: SourceManga): SearchResultItem => ({
  mangaId: manga.mangaId,
  title: manga.mangaInfo.primaryTitle,
  imageUrl: manga.mangaInfo.thumbnailUrl,
  contentRating: manga.mangaInfo.contentRating,
});

export class MgekoClient {
  private readonly seriesCache = new AsyncKeyedCache<string, string>({
    ttlMs: 120_000,
    maxEntries: 64,
  });
  private readonly chapterCache = new AsyncKeyedCache<string, string>({
    ttlMs: 30_000,
    maxEntries: 48,
  });
  private readonly filterCache = new AsyncKeyedCache<"filters", string>({
    ttlMs: 15 * 60_000,
    maxEntries: 1,
  });

  async getBrowsePage(
    query: SearchQuery<MgekoSearchMetadata>,
    sortingOption: SortingOption | undefined,
    page: number,
    safeMode: boolean,
  ): Promise<MgekoBrowsePage> {
    const raw = await fetchJson<unknown>({
      url: buildBrowseUrl(query, sortingOption, page, safeMode),
      method: "GET",
    });
    const envelope = parseBrowseResponse(raw);
    return {
      ...envelope,
      items: parseBrowseCards(envelope.resultsHtml, { safeMode }),
    };
  }

  async getFilterOptions(): Promise<MgekoFilterOptions> {
    const html = await this.filterCache.get("filters", () =>
      fetchText({ url: `${DOMAIN}/browse-comics/`, method: "GET" }),
    );
    return parseFilterOptions(html);
  }

  async getMangaDetails(mangaId: string): Promise<SourceManga> {
    const key = `manga:${mangaId}`;
    const html = await this.seriesCache.get(key, () =>
      fetchText({ url: buildMangaUrl(mangaId), method: "GET" }),
    );
    return parseMangaDetails(html, mangaId);
  }

  async getChapters(sourceManga: SourceManga, sinceDate?: Date): Promise<Chapter[]> {
    const key = `chapters:${sourceManga.mangaId}`;
    const html = await this.chapterCache.get(key, () =>
      fetchText({ url: buildChaptersUrl(sourceManga.mangaId), method: "GET" }),
    );
    const chapters = parseChapters(html, sourceManga);
    if (!sinceDate || Number.isNaN(sinceDate.getTime())) return chapters;
    return chapters.filter(
      (chapter) => !chapter.publishDate || chapter.publishDate.getTime() > sinceDate.getTime(),
    );
  }

  async getChapterDetails(chapter: Chapter): Promise<ChapterDetails> {
    const html = await fetchText({ url: buildChapterUrl(chapter.chapterId), method: "GET" });
    return parseChapterDetails(html, chapter);
  }

  async resolvePastedUrl(query: string): Promise<PagedResults<SearchResultItem> | undefined> {
    const mangaId = parseMangaUrl(query);
    if (!mangaId) return undefined;
    try {
      return { items: [searchItem(await this.getMangaDetails(mangaId))] };
    } catch {
      return undefined;
    }
  }

  invalidateCaches(): void {
    this.seriesCache.clear();
    this.chapterCache.clear();
    this.filterCache.clear();
  }
}
