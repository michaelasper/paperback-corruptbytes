import type {
  Chapter,
  ChapterDetails,
  PagedResults,
  SearchQuery,
  SearchResultItem,
  SortingOption,
  SourceManga,
} from "@paperback/types";

import { utf8ByteLength } from "../shared/async-cache.js";
import type { AsyncKeyedCacheOptions } from "../shared/async-cache.js";
import type {
  RinkoCatalogPage,
  RinkoChapterRow,
  RinkoGenre,
  RinkoSearchMetadata,
} from "./models.js";
import {
  MAX_CATALOG_PAGES,
  MAX_CHAPTER_BATCHES,
  MAX_CHAPTERS,
  buildArchiveCatalogRequest,
  buildChapterAjaxRequest,
  buildChapterUrl,
  buildGenreRequest,
  buildRestCatalogRequest,
  buildSeriesLookupRequest,
  buildSeriesUrl,
  decodeRinkoChapterId,
  decodeRinkoMangaId,
  fetchHtml,
  fetchJsonResponse,
  needsArchiveCatalog,
  normalizePageNumber,
  normalizeRinkoSearchQuery,
  parseSeriesUrl,
} from "./network.js";
import {
  cloneChapterRow,
  parseAjaxChapterRows,
  parseArchiveCatalogPage,
  parseChapterDetails,
  parseGenrePage,
  parseRestCatalogPage,
  parseRestSeriesLookup,
  parseSeriesDocument,
  sortChapterRows,
  sortGenres,
} from "./parsers.js";

const IntrinsicDate = Date;
const dateGetTimeMethod: unknown = (
  Object.getOwnPropertyDescriptor(Date.prototype, "getTime") as { value?: unknown } | undefined
)?.value;
const dateGetTime = (value: unknown): number => {
  if (typeof dateGetTimeMethod !== "function") throw new Error("Date intrinsic is unavailable.");
  return Reflect.apply(dateGetTimeMethod, value, []) as number;
};
const dateNowMethod: unknown = (
  Object.getOwnPropertyDescriptor(Date, "now") as { value?: unknown } | undefined
)?.value;
const intrinsicDateNow = (): number => {
  if (typeof dateNowMethod !== "function") throw new Error("Date intrinsic is unavailable.");
  return Reflect.apply(dateNowMethod, IntrinsicDate, []) as number;
};

const safeTimestamp = (value: unknown): number | undefined => {
  try {
    const result = dateGetTime(value);
    return Number.isFinite(result) ? result : undefined;
  } catch {
    return undefined;
  }
};

const MAX_PENDING_CACHE_LOADS = 16;

interface BoundedCacheEntry<V> {
  promise: Promise<V>;
  expiresAt: number;
  pending: boolean;
  weight?: number;
}

/** Rinko-local cache with fail-fast admission for genuine pending misses only. */
class BoundedAsyncKeyedCache<K, V> {
  private readonly entries = new Map<K, BoundedCacheEntry<V>>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly maxWeight: number | undefined;
  private readonly weigh: AsyncKeyedCacheOptions<V>["weigh"];
  private readonly now: () => number;
  private readonly maxPending: number;
  private totalWeight = 0;
  private pendingLoadCount = 0;

  constructor(options: AsyncKeyedCacheOptions<V>, maxPending = MAX_PENDING_CACHE_LOADS) {
    if (
      options.maxWeight !== undefined &&
      options.maxBytes !== undefined &&
      options.maxWeight !== options.maxBytes
    ) {
      throw new Error("Rinko Comics cache weight limits are invalid.");
    }
    const configuredWeight = options.maxWeight ?? options.maxBytes;
    if (
      !Number.isFinite(options.ttlMs) ||
      options.ttlMs < 0 ||
      !Number.isSafeInteger(options.maxEntries) ||
      options.maxEntries < 1 ||
      !Number.isSafeInteger(maxPending) ||
      maxPending < 1 ||
      (configuredWeight !== undefined &&
        (!Number.isFinite(configuredWeight) || configuredWeight < 0)) ||
      (options.weigh !== undefined && typeof options.weigh !== "function") ||
      (configuredWeight !== undefined) !== (options.weigh !== undefined)
    ) {
      throw new Error("Rinko Comics cache configuration is invalid.");
    }
    this.ttlMs = options.ttlMs;
    this.maxEntries = options.maxEntries;
    this.maxWeight = configuredWeight;
    this.weigh = options.weigh;
    this.now = options.now ?? intrinsicDateNow;
    this.maxPending = maxPending;
  }

  get(key: K, load: () => Promise<V>): Promise<V> {
    const existing = this.entries.get(key);
    if (existing?.pending) {
      this.touch(key, existing);
      return existing.promise;
    }
    if (existing) {
      const now = this.currentTime();
      if (this.entries.get(key) !== existing) {
        const replacement = this.entries.get(key);
        if (replacement) return replacement.promise;
      } else if (now !== undefined && existing.expiresAt > now) {
        this.touch(key, existing);
        return existing.promise;
      } else {
        this.removeIfCurrent(key, existing);
      }
    }
    if (this.pendingLoadCount >= this.maxPending) {
      return Promise.reject(
        new Error("Rinko Comics has too many concurrent cache loads. Please try again."),
      );
    }

    this.pendingLoadCount += 1;
    const entry: BoundedCacheEntry<V> = {
      promise: Promise.resolve().then(load),
      expiresAt: Number.POSITIVE_INFINITY,
      pending: true,
    };
    this.entries.set(key, entry);
    this.evictOverflow();
    void entry.promise.then(
      (value) => {
        this.pendingLoadCount -= 1;
        try {
          this.settle(key, entry, value);
        } catch {
          this.removeIfCurrent(key, entry);
        }
      },
      () => {
        this.pendingLoadCount -= 1;
        this.removeIfCurrent(key, entry);
      },
    );
    return entry.promise;
  }

  getMapped<T>(key: K, load: () => Promise<V>, map: (value: V) => T | PromiseLike<T>): Promise<T> {
    const promise = this.get(key, load);
    return promise.then(async (value) => {
      try {
        return await map(value);
      } catch (error: unknown) {
        this.removeIfCurrentPromise(key, promise);
        throw error;
      }
    });
  }

  delete(key: K): void {
    this.removeEntry(key);
  }

  clear(): void {
    this.entries.clear();
    this.totalWeight = 0;
  }

  private settle(key: K, entry: BoundedCacheEntry<V>, value: V): void {
    if (this.entries.get(key) !== entry) return;
    let weight: number | undefined;
    if (this.weigh) {
      try {
        weight = this.weigh(value);
      } catch {
        this.removeIfCurrent(key, entry);
        return;
      }
      if (this.entries.get(key) !== entry) return;
      if (!Number.isFinite(weight) || weight < 0) {
        this.removeIfCurrent(key, entry);
        return;
      }
    }
    const now = this.currentTime();
    if (this.entries.get(key) !== entry) return;
    if (now === undefined || !Number.isFinite(now + this.ttlMs)) {
      this.removeIfCurrent(key, entry);
      return;
    }
    entry.pending = false;
    entry.expiresAt = now + this.ttlMs;
    entry.weight = weight;
    if (weight !== undefined) this.totalWeight += weight;
    this.touch(key, entry);
    this.evictOverflow();
  }

  private currentTime(): number | undefined {
    try {
      const value = this.now();
      return typeof value === "number" && Number.isFinite(value) ? value : undefined;
    } catch {
      return undefined;
    }
  }

  private touch(key: K, entry: BoundedCacheEntry<V>): void {
    if (this.entries.get(key) !== entry) return;
    this.entries.delete(key);
    this.entries.set(key, entry);
  }

  private evictOverflow(): void {
    while (
      this.entries.size > this.maxEntries ||
      (this.maxWeight !== undefined && this.totalWeight > this.maxWeight)
    ) {
      let oldestResolvedKey: K | undefined;
      for (const [key, entry] of this.entries) {
        if (!entry.pending) {
          oldestResolvedKey = key;
          break;
        }
      }
      if (oldestResolvedKey === undefined) return;
      this.removeEntry(oldestResolvedKey);
    }
  }

  private removeIfCurrent(key: K, entry: BoundedCacheEntry<V>): void {
    if (this.entries.get(key) === entry) this.removeEntry(key);
  }

  private removeIfCurrentPromise(key: K, promise: Promise<V>): void {
    const entry = this.entries.get(key);
    if (entry?.promise === promise) this.removeEntry(key);
  }

  private removeEntry(key: K): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    if (entry.weight !== undefined) {
      let totalWeight = 0;
      for (const remaining of this.entries.values()) {
        if (remaining.weight !== undefined) totalWeight += remaining.weight;
      }
      this.totalWeight = totalWeight;
    }
  }
}

const cloneRows = (rows: readonly RinkoChapterRow[]): RinkoChapterRow[] =>
  rows.map(cloneChapterRow);

const chapterRowsWeight = (rows: readonly RinkoChapterRow[]): number => {
  let total = 0;
  for (const row of rows) {
    total += 64;
    for (const value of [row.chapterId, row.postId, row.slug, row.url, row.siteTitle, row.title]) {
      if (value !== undefined) total += utf8ByteLength(value);
    }
  }
  return total;
};

const validatedMangaId = (value: unknown): string => {
  try {
    decodeRinkoMangaId(value);
  } catch {
    throw new Error("Rinko Comics source manga is invalid.");
  }
  return value as string;
};

const sourceMangaId = (value: unknown): string => {
  let mangaId: unknown;
  try {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      !Object.prototype.hasOwnProperty.call(value, "mangaId")
    ) {
      throw new Error("invalid");
    }
    mangaId = (value as Record<string, unknown>)["mangaId"];
  } catch {
    throw new Error("Rinko Comics source manga is invalid.");
  }
  return validatedMangaId(mangaId);
};

const chapterInput = (
  value: unknown,
): {
  chapterId: string;
  chapNum: number;
  mangaId: string;
} => {
  let chapterId: unknown;
  let chapNum: unknown;
  let sourceManga: unknown;
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("invalid");
    }
    if (
      !Object.prototype.hasOwnProperty.call(value, "chapterId") ||
      !Object.prototype.hasOwnProperty.call(value, "chapNum") ||
      !Object.prototype.hasOwnProperty.call(value, "sourceManga")
    ) {
      throw new Error("invalid");
    }
    const record = value as Record<string, unknown>;
    chapterId = record["chapterId"];
    chapNum = record["chapNum"];
    sourceManga = record["sourceManga"];
  } catch {
    throw new Error("Rinko Comics chapter is invalid.");
  }
  const mangaId = sourceMangaId(sourceManga);
  try {
    decodeRinkoChapterId(chapterId);
  } catch {
    throw new Error("Rinko Comics chapter is invalid.");
  }
  if (
    typeof chapNum !== "number" ||
    !Number.isFinite(chapNum) ||
    chapNum < 0 ||
    Object.is(chapNum, -0) ||
    chapNum > 10_000_000 ||
    !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(String(chapNum))
  ) {
    throw new Error("Rinko Comics chapter number is invalid.");
  }
  return {
    chapterId: chapterId as string,
    chapNum,
    mangaId,
  };
};

export class RinkoComicsClient {
  private readonly seriesCache = new BoundedAsyncKeyedCache<string, string>({
    ttlMs: 30_000,
    maxEntries: 32,
    maxBytes: 16 * 1_024 * 1_024,
    weigh: utf8ByteLength,
  });

  private readonly chapterCache = new BoundedAsyncKeyedCache<string, RinkoChapterRow[]>({
    ttlMs: 30_000,
    maxEntries: 32,
    maxBytes: 16 * 1_024 * 1_024,
    weigh: chapterRowsWeight,
  });

  private readonly genreCache = new BoundedAsyncKeyedCache<string, RinkoGenre[]>({
    ttlMs: 30 * 60_000,
    maxEntries: 1,
  });

  async getCatalogPage(
    query: SearchQuery<RinkoSearchMetadata>,
    sortingOption: SortingOption | undefined,
    page: number,
  ): Promise<RinkoCatalogPage> {
    const currentPage = normalizePageNumber(page);
    const normalizedQuery = normalizeRinkoSearchQuery(query);
    if (needsArchiveCatalog(normalizedQuery, sortingOption)) {
      const request = buildArchiveCatalogRequest(normalizedQuery, sortingOption, currentPage);
      const expectedNextUrl =
        currentPage < MAX_CATALOG_PAGES
          ? buildArchiveCatalogRequest(normalizedQuery, sortingOption, currentPage + 1).url
          : undefined;
      return parseArchiveCatalogPage(await fetchHtml(request), currentPage, expectedNextUrl);
    }
    const request = buildRestCatalogRequest(normalizedQuery.title, currentPage);
    const result = await fetchJsonResponse<unknown>(request);
    return parseRestCatalogPage(result.value, result.response.headers, currentPage);
  }

  async getGenres(): Promise<RinkoGenre[]> {
    const genres = await this.genreCache.get("genres", async () => {
      const output: RinkoGenre[] = [];
      let expectedTotal: number | undefined;
      let pageCount: number | undefined;
      for (let page = 1; page <= (pageCount ?? 1); page += 1) {
        const request = buildGenreRequest(page);
        const result = await fetchJsonResponse<unknown>(request, 512 * 1_024);
        const parsed = parseGenrePage(result.value, result.response.headers, page);
        if (expectedTotal === undefined) {
          expectedTotal = parsed.totalCount;
          pageCount = parsed.pageCount;
        } else if (parsed.totalCount !== expectedTotal || parsed.pageCount !== pageCount) {
          throw new Error("Rinko Comics returned inconsistent genre pages.");
        }
        output.push(...parsed.genres);
      }
      if (
        expectedTotal === undefined ||
        pageCount === undefined ||
        output.length !== expectedTotal ||
        new Set(output.map((genre) => genre.id)).size !== output.length ||
        new Set(output.map((genre) => genre.postId)).size !== output.length
      ) {
        throw new Error("Rinko Comics returned an incomplete genre catalog.");
      }
      return sortGenres(output.filter((genre) => genre.count > 0));
    });
    return genres.map((genre) => ({ ...genre }));
  }

  private getSeriesHtml(mangaId: string): Promise<string> {
    const request = buildSeriesUrl(mangaId);
    return this.seriesCache.get(mangaId, () => fetchHtml({ url: request, method: "GET" }));
  }

  async getMangaDetails(mangaId: string): Promise<SourceManga> {
    const sourceId = validatedMangaId(mangaId);
    return this.seriesCache.getMapped(
      sourceId,
      () => fetchHtml({ url: buildSeriesUrl(sourceId), method: "GET" }),
      (html) => parseSeriesDocument(html, sourceId).manga,
    );
  }

  private async loadCompleteChapterRows(mangaId: string): Promise<RinkoChapterRow[]> {
    const html = await this.getSeriesHtml(mangaId);
    const series = parseSeriesDocument(html, mangaId);
    const rows = cloneRows(series.initialRows);
    if (series.chapterCount > rows.length) {
      const context = series.ajaxContext;
      if (!context) throw new Error("Rinko Comics omitted required chapter pagination.");
      let offset = context.nextOffset;
      let sawTerminalPage = false;
      for (let batch = 0; batch < MAX_CHAPTER_BATCHES; batch += 1) {
        const request = buildChapterAjaxRequest(context, offset);
        const result = await fetchJsonResponse<unknown>(request, 512 * 1_024);
        const pageRows = parseAjaxChapterRows(result.value, series.manga.mangaInfo.primaryTitle);
        if (pageRows.length === 0) {
          sawTerminalPage = true;
          break;
        }
        rows.push(...pageRows.map(cloneChapterRow));
        if (rows.length > series.chapterCount || rows.length > MAX_CHAPTERS) {
          throw new Error("Rinko Comics returned more chapters than declared.");
        }
        if (rows.length < series.chapterCount && pageRows.length !== 10) {
          throw new Error("Rinko Comics returned a truncated chapter page.");
        }
        offset += 10;
      }
      if (!sawTerminalPage) {
        throw new Error("Rinko Comics returned too many chapter pages to process safely.");
      }
    }
    if (rows.length !== series.chapterCount) {
      throw new Error("Rinko Comics returned an incomplete chapter history.");
    }
    const postIds = rows.map((row) => row.postId);
    const chapterIds = rows.flatMap((row) => (row.chapterId ? [row.chapterId] : []));
    const publicSlugs = rows.flatMap((row) => (row.slug ? [row.slug] : []));
    const publicUrls = rows.flatMap((row) => (row.url ? [row.url] : []));
    if (
      new Set(postIds).size !== postIds.length ||
      new Set(chapterIds).size !== chapterIds.length ||
      new Set(publicSlugs).size !== publicSlugs.length ||
      new Set(publicUrls).size !== publicUrls.length ||
      rows.some((row) => row.isPublic && (!row.chapterId || !row.slug || !row.url))
    ) {
      throw new Error("Rinko Comics returned conflicting chapter rows.");
    }
    return sortChapterRows(rows);
  }

  async getChapters(sourceManga: SourceManga, sinceDate?: Date): Promise<Chapter[]> {
    const mangaId = sourceMangaId(sourceManga);
    const since = safeTimestamp(sinceDate);
    if (sinceDate !== undefined && since === undefined) {
      throw new Error("Rinko Comics chapter date filter is invalid.");
    }
    const rows = await this.chapterCache.get(mangaId, async () => {
      try {
        return await this.loadCompleteChapterRows(mangaId);
      } catch (error: unknown) {
        this.seriesCache.delete(mangaId);
        throw error;
      }
    });
    return rows
      .filter((row) => row.isPublic && row.chapterId && row.url)
      .filter((row) => {
        if (since === undefined || !row.publishDate) return true;
        const timestamp = safeTimestamp(row.publishDate);
        return timestamp === undefined || timestamp > since;
      })
      .map(
        (row, index): Chapter => ({
          chapterId: row.chapterId!,
          sourceManga,
          langCode: "en",
          chapNum: row.chapNum,
          ...(row.title && { title: row.title }),
          ...(row.publishDate && {
            publishDate: new IntrinsicDate(dateGetTime(row.publishDate)),
          }),
          sortingIndex: index,
          additionalInfo: {
            slug: row.slug!,
            postId: row.postId,
            url: row.url!,
          },
        }),
      );
  }

  async getChapterDetails(chapter: Chapter): Promise<ChapterDetails> {
    const input = chapterInput(chapter);
    const { mangaId } = input;
    // Reader authorization is deliberately uncached: a chapter that was public
    // moments ago may have been locked since the list was last viewed.
    this.chapterCache.delete(mangaId);
    this.seriesCache.delete(mangaId);
    const current = await this.loadCompleteChapterRows(mangaId);
    const authorized = current.find(
      (candidate) => candidate.isPublic && candidate.chapterId === input.chapterId,
    );
    if (!authorized) {
      throw new Error("This chapter is not publicly readable on Rinko Comics.");
    }
    if (authorized.chapNum !== input.chapNum) {
      throw new Error("Rinko Comics chapter metadata changed. Please refresh the chapter list.");
    }
    const request = { url: buildChapterUrl(authorized.chapterId!), method: "GET" };
    return parseChapterDetails(
      await fetchHtml(request),
      authorized.chapterId!,
      mangaId,
      authorized.chapNum,
      authorized.siteTitle,
    );
  }

  async resolvePastedUrl(value: string): Promise<PagedResults<SearchResultItem> | undefined> {
    const slug = parseSeriesUrl(value);
    if (!slug) return undefined;
    const request = buildSeriesLookupRequest(slug);
    const result = await fetchJsonResponse<unknown>(request);
    const item = parseRestSeriesLookup(result.value, slug);
    return {
      items: item
        ? [
            {
              mangaId: item.mangaId,
              title: item.title,
              imageUrl: item.imageUrl,
              subtitle: item.genres.join(" • ") || undefined,
              contentRating: item.contentRating,
            },
          ]
        : [],
    };
  }

  invalidateCaches(): void {
    this.seriesCache.clear();
    this.chapterCache.clear();
    this.genreCache.clear();
  }
}
