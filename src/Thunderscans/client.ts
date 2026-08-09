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

import { AsyncKeyedCache } from "../shared/async-cache.js";
import type {
  HomeFeedId,
  ParsedHomeFeed,
  ParsedListPage,
  ThunderSearchMetadata,
} from "./models.js";
import {
  COMICS_URL,
  DOMAIN,
  buildAutocompleteRequest,
  buildChapterFallbackUrl,
  buildDirectoryUrl,
  buildLoadMoreRequest,
  buildMangaUrl,
  fetchJSON,
  fetchText,
  parseSeriesUrl,
} from "./network.js";
import {
  parseAutocompleteResults,
  parseChapterDetails,
  parseChapterList,
  parseDirectoryPage,
  parseGenres,
  parseHomeFeed,
  parseMangaDetails,
} from "./parsers.js";

const SERIES_CACHE_TTL_MS = 30_000;
const HOME_CACHE_TTL_MS = 45_000;
const GENRE_CACHE_TTL_MS = 30 * 60_000;
const MAX_CHAPTER_URLS = 2_048;

const ajaxHtml = (body: string): string | undefined => {
  const trimmed = body.trim();
  if (!trimmed) return undefined;
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return body;
  try {
    const parsed = JSON.parse(trimmed) as { success?: unknown; data?: unknown };
    if (parsed.success === false) return undefined;
    return typeof parsed.data === "string" ? parsed.data : undefined;
  } catch {
    return body;
  }
};

export class ThunderClient {
  private readonly seriesCache = new AsyncKeyedCache<string, string>({
    ttlMs: SERIES_CACHE_TTL_MS,
    maxEntries: 64,
  });
  private readonly homeCache = new AsyncKeyedCache<string, string>({
    ttlMs: HOME_CACHE_TTL_MS,
    maxEntries: 1,
  });
  private readonly genreCache = new AsyncKeyedCache<string, Tag[]>({
    ttlMs: GENRE_CACHE_TTL_MS,
    maxEntries: 1,
  });
  private readonly chapterUrls = new Map<string, string>();

  async getDirectoryPage(
    query: SearchQuery<ThunderSearchMetadata>,
    sortingOption: SortingOption | undefined,
    page: number,
  ): Promise<ParsedListPage> {
    const html = await fetchText({
      url: buildDirectoryUrl(query, sortingOption, page),
      method: "GET",
    });
    return parseDirectoryPage(html);
  }

  async getHomeFeed(feed: HomeFeedId, page?: number): Promise<ParsedHomeFeed> {
    if ((feed === "latestComics" || feed === "latestNovels") && page !== undefined) {
      const body = await fetchText(buildLoadMoreRequest(feed, page));
      const fragment = ajaxHtml(body);
      if (!fragment) return { items: [] };
      const parsed = parseDirectoryPage(`<div class="listupd">${fragment}</div>`);
      return {
        items: parsed.items,
        ...(parsed.items.length > 0 && { nextPage: page + 1 }),
      };
    }

    const html = await this.homeCache.get("home", () =>
      fetchText({ url: `${DOMAIN}/`, method: "GET" }),
    );
    return parseHomeFeed(html, feed);
  }

  async getGenres(): Promise<Tag[]> {
    const genres = await this.genreCache.get("genres", async () =>
      parseGenres(await fetchText({ url: COMICS_URL, method: "GET" })),
    );
    return genres.map((genre) => ({ ...genre }));
  }

  async getAutocompleteResults(
    title: string,
    metadata?: ThunderSearchMetadata,
  ): Promise<ReturnType<typeof parseAutocompleteResults>> {
    let translatedMetadata = metadata;
    const selectedGenres = Object.keys(metadata?.genres ?? {});
    if (selectedGenres.some((id) => /^\d+$/.test(id))) {
      const titles = new Map((await this.getGenres()).map((genre) => [genre.id, genre.title]));
      translatedMetadata = {
        ...metadata,
        genres: Object.fromEntries(
          Object.entries(metadata?.genres ?? {}).map(([id, state]) => [
            titles.get(id) ?? id,
            state,
          ]),
        ),
      };
    }
    return parseAutocompleteResults(
      await fetchJSON(buildAutocompleteRequest(title)),
      translatedMetadata,
    );
  }

  async getMangaDetails(mangaId: string): Promise<SourceManga> {
    return parseMangaDetails(await this.getSeriesHtml(mangaId), mangaId);
  }

  async getChapters(sourceManga: SourceManga, showLocked: boolean): Promise<Chapter[]> {
    const chapters = parseChapterList(await this.getSeriesHtml(sourceManga.mangaId), sourceManga, {
      showLocked,
    });
    this.rememberChapterUrls(chapters);
    return chapters;
  }

  async getChapterDetails(chapter: Chapter): Promise<ChapterDetails> {
    let resolvedChapter = chapter;
    let url = chapter.additionalInfo?.url ?? this.chapterUrls.get(this.chapterKey(chapter));

    if (!url) {
      const chapters = await this.getChapters(chapter.sourceManga, true);
      resolvedChapter =
        chapters.find((candidate) => candidate.chapterId === chapter.chapterId) ?? chapter;
      url = resolvedChapter.additionalInfo?.url ?? this.chapterUrls.get(this.chapterKey(chapter));
    }

    const remainsLocked = resolvedChapter.additionalInfo?.locked === "true";
    if (!url && !remainsLocked) {
      const slug = chapter.sourceManga.mangaInfo.additionalInfo?.slug;
      if (slug) url = buildChapterFallbackUrl(slug, chapter.chapterId);
    }
    if (!url) {
      throw new Error(
        "This chapter is still locked on Thunder Scans. Sign in from the extension settings if you already purchased it.",
      );
    }

    const html = await fetchText({
      url,
      method: "GET",
      headers: { "cache-control": "no-store" },
    });
    return parseChapterDetails(html, {
      ...chapter,
      additionalInfo: { ...chapter.additionalInfo, ...resolvedChapter.additionalInfo, url },
    });
  }

  async resolvePastedUrl(query: string): Promise<PagedResults<SearchResultItem> | undefined> {
    const slug = parseSeriesUrl(query);
    if (!slug) return undefined;
    try {
      const manga = await this.getMangaDetails(slug);
      return {
        items: [
          {
            mangaId: manga.mangaId,
            title: manga.mangaInfo.primaryTitle,
            imageUrl: manga.mangaInfo.thumbnailUrl,
            contentRating: manga.mangaInfo.contentRating,
          },
        ],
      };
    } catch {
      return undefined;
    }
  }

  invalidateAuthenticationCaches(): void {
    this.seriesCache.clear();
    this.chapterUrls.clear();
  }

  private getSeriesHtml(mangaId: string): Promise<string> {
    return this.seriesCache.get(mangaId, () =>
      fetchText({ url: buildMangaUrl(mangaId), method: "GET" }),
    );
  }

  private chapterKey(chapter: Chapter): string {
    return `${chapter.sourceManga.mangaId}\u0000${chapter.chapterId}`;
  }

  private rememberChapterUrls(chapters: Chapter[]): void {
    for (const chapter of chapters) {
      const url = chapter.additionalInfo?.url;
      if (!url) continue;
      const key = this.chapterKey(chapter);
      this.chapterUrls.delete(key);
      this.chapterUrls.set(key, url);
      while (this.chapterUrls.size > MAX_CHAPTER_URLS) {
        const oldest = this.chapterUrls.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        this.chapterUrls.delete(oldest);
      }
    }
  }
}
