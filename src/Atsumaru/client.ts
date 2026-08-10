import type {
  Chapter,
  ChapterDetails,
  PagedResults,
  Request,
  SearchQuery,
  SearchResultItem,
  SortingOption,
  SourceManga,
} from "@paperback/types";

import { AsyncKeyedCache, utf8ByteLength } from "../shared/async-cache.js";
import { SourceHttpError } from "../shared/http.js";
import type {
  AtsumaruCatalogPage,
  AtsumaruDiscoveryPreferences,
  AtsumaruFilterOptions,
  AtsumaruHomeFeed,
  AtsumaruSearchMetadata,
  AtsumaruTaxonomy,
} from "./models.js";
import {
  AVAILABLE_FILTERS_URL,
  assertAtsumaruApiSuccess,
  buildAllChaptersUrl,
  buildChapterUrl,
  buildHomeUrl,
  buildMangaDocumentUrl,
  buildMangaPageUrl,
  buildNovelChapterUrl,
  buildSearchUrl,
  fetchText,
  MANGA_RATING_MAX_BYTES,
  parseMangaUrl,
  parseNovelUrl,
  type AtsumaruFetchBodyOptions,
} from "./network.js";
import {
  parseAvailableFilters,
  parseChapters,
  parseComicChapter,
  parseFeedResponse,
  parseMangaPage,
  parseMangaRatingDocument,
  parseNovelChapter,
  parseScanlators,
  parseSearchResponse,
  type AtsumaruRatingDocument,
} from "./parsers.js";

export interface AtsumaruTransport {
  fetchText(request: Request, options?: AtsumaruFetchBodyOptions): Promise<string>;
}

const defaultTransport: AtsumaruTransport = { fetchText };

const decodeJson = (body: string): unknown => {
  if (/^\s*(?:<!doctype\s+html\b|<html\b|<head\b|<body\b|<title\b)/i.test(body)) {
    throw new Error("Atsumaru returned HTML instead of JSON.");
  }
  try {
    return assertAtsumaruApiSuccess(JSON.parse(body));
  } catch (error: unknown) {
    if (error instanceof Error && /^Atsumaru.*reported failure/i.test(error.message)) throw error;
    throw new Error("Atsumaru returned invalid JSON.", { cause: error });
  }
};

const searchItem = (manga: SourceManga): SearchResultItem => ({
  mangaId: manga.mangaId,
  title: manga.mangaInfo.primaryTitle,
  imageUrl: manga.mangaInfo.thumbnailUrl,
  contentRating: manga.mangaInfo.contentRating,
});

const cloneFilterOptions = (filters: AtsumaruFilterOptions): AtsumaruFilterOptions => ({
  genres: filters.genres.map((genre) => ({ ...genre })),
  statuses: filters.statuses.map((status) => ({ ...status })),
  tags: filters.tags.map((tag) => ({ ...tag })),
  types: filters.types.map((type) => ({ ...type })),
  ...(filters.mediums && { mediums: filters.mediums.map((medium) => ({ ...medium })) }),
  ...(filters.contentRatings && {
    contentRatings: filters.contentRatings.map((rating) => ({ ...rating })),
  }),
  ...(filters.tagGroups && {
    tagGroups: filters.tagGroups.map((group) => ({
      ...group,
      tags: group.tags.map((tag) => ({ ...tag })),
    })),
  }),
});

const newestTranslationPerNumber = (chapters: Chapter[]): Chapter[] => {
  const selected = new Map<number, Chapter>();
  for (const chapter of chapters) {
    const current = selected.get(chapter.chapNum);
    const currentTime = current?.publishDate?.getTime() ?? Number.NEGATIVE_INFINITY;
    const candidateTime = chapter.publishDate?.getTime() ?? Number.NEGATIVE_INFINITY;
    if (
      !current ||
      candidateTime > currentTime ||
      (candidateTime === currentTime && chapter.chapterId.localeCompare(current.chapterId) > 0)
    ) {
      selected.set(chapter.chapNum, chapter);
    }
  }
  return [...selected.values()]
    .sort(
      (left, right) =>
        left.chapNum - right.chapNum ||
        (left.sortingIndex ?? 0) - (right.sortingIndex ?? 0) ||
        left.chapterId.localeCompare(right.chapterId),
    )
    .map((chapter, sortingIndex) => ({ ...chapter, sortingIndex }));
};

/** The live availableFilters payload is about 259 KiB; retain 2× headroom. */
export const AVAILABLE_FILTERS_MAX_BYTES = 512 * 1_024;
/** Bound the parsed taxonomy independently of the raw endpoint response. */
const FILTER_CACHE_MAX_WEIGHT = 1 * 1_024 * 1_024;
const FILTER_ROOT_WEIGHT = 256;
const FILTER_LIST_WEIGHT = 24;
const FILTER_ITEM_WEIGHT = 64;
const FILTER_GROUP_WEIGHT = 64;

type TaxonomyWithNamePath = AtsumaruTaxonomy & { namePath?: string };

const stringWeight = (value: string | undefined): number =>
  value === undefined ? 0 : utf8ByteLength(value);

const taxonomyWeight = (value: AtsumaruTaxonomy): number => {
  const taxonomy = value as TaxonomyWithNamePath;
  return (
    FILTER_ITEM_WEIGHT +
    stringWeight(taxonomy.id) +
    stringWeight(taxonomy.name) +
    stringWeight(taxonomy.title) +
    stringWeight(taxonomy.group) +
    stringWeight(taxonomy.namePath) +
    (taxonomy.adult === undefined ? 0 : 1) +
    (taxonomy.safeCount === undefined ? 0 : 8) +
    (taxonomy.adultCount === undefined ? 0 : 8)
  );
};

const filterOptionsWeight = (filters: AtsumaruFilterOptions): number => {
  let weight = FILTER_ROOT_WEIGHT;
  const addList = (values: readonly AtsumaruTaxonomy[] | undefined): void => {
    if (!values) return;
    weight += FILTER_LIST_WEIGHT;
    for (const value of values) weight += taxonomyWeight(value);
  };
  addList(filters.genres);
  addList(filters.statuses);
  addList(filters.tags);
  addList(filters.types);
  addList(filters.mediums);
  addList(filters.contentRatings);
  if (filters.tagGroups) {
    weight += FILTER_LIST_WEIGHT;
    for (const group of filters.tagGroups) {
      weight += FILTER_GROUP_WEIGHT + stringWeight(group.id) + stringWeight(group.name);
      for (const tag of group.tags) weight += taxonomyWeight(tag);
    }
  }
  return weight;
};

const SEARCH_CACHE_MAX_BYTES = 2 * 1_024 * 1_024;
const HOME_CACHE_MAX_BYTES = 4 * 1_024 * 1_024;
const SERIES_CACHE_MAX_BYTES = 2 * 1_024 * 1_024;
const CHAPTERS_CACHE_MAX_BYTES = 4 * 1_024 * 1_024;
const RATING_CACHE_MAX_ENTRIES = 64;
const RATING_CACHE_MAX_BYTES = 64 * 1_024;
const SCANLATOR_METADATA_KEY = "atsumaruScanlators";
export const CANONICAL_MANGA_ID_KEY = "atsumaruCanonicalMangaId";
const SCANLATOR_METADATA_MAX_BYTES = 64 * 1_024;

/** Preserve optional labels across Paperback runtime reloads without another chapter-list request. */
const encodeScanlatorMetadata = (pageValue: unknown): string | undefined => {
  const entries = Object.entries(parseScanlators(pageValue));
  if (entries.length === 0) return undefined;
  const encoded = JSON.stringify({
    scanlators: entries.map(([id, name]) => ({ id, name })),
  });
  return utf8ByteLength(encoded) <= SCANLATOR_METADATA_MAX_BYTES ? encoded : undefined;
};

const scanlatorsFromManga = (sourceManga: SourceManga): Record<string, string> | undefined => {
  const encoded = sourceManga.mangaInfo.additionalInfo?.[SCANLATOR_METADATA_KEY];
  if (!encoded || utf8ByteLength(encoded) > SCANLATOR_METADATA_MAX_BYTES) return undefined;
  try {
    const scanlators = parseScanlators(JSON.parse(encoded));
    return Object.keys(scanlators).length > 0 ? scanlators : undefined;
  } catch {
    return undefined;
  }
};

const validMangaId = (value: string | undefined): string | undefined => {
  if (!value) return undefined;
  try {
    buildAllChaptersUrl(value);
    return value;
  } catch {
    return undefined;
  }
};

const canonicalMangaIdFromManga = (sourceManga: SourceManga): string | undefined =>
  validMangaId(sourceManga.mangaInfo.additionalInfo?.[CANONICAL_MANGA_ID_KEY]);

const canonicalMangaIdFromChapter = (chapter: Chapter): string | undefined =>
  validMangaId(chapter.additionalInfo?.[CANONICAL_MANGA_ID_KEY]);

const titleIdentity = (value: string): string =>
  value
    .normalize("NFKC")
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase();

const chapterSourceManga = (sourceManga: SourceManga): SourceManga => {
  const storedAdditionalInfo = sourceManga.mangaInfo.additionalInfo;
  // Every Chapter crosses the native bridge with its SourceManga. Avoid
  // returning the app-owned input object and multiplying private lookup
  // metadata across the entire chapter list.
  const additionalInfo = storedAdditionalInfo ? { ...storedAdditionalInfo } : undefined;
  if (additionalInfo) {
    delete additionalInfo[SCANLATOR_METADATA_KEY];
    delete additionalInfo[CANONICAL_MANGA_ID_KEY];
  }
  return {
    ...sourceManga,
    mangaInfo: {
      ...sourceManga.mangaInfo,
      ...(additionalInfo && { additionalInfo }),
    },
  };
};

const ratingWeight = (value: AtsumaruRatingDocument | null): number => {
  if (value === null) return 1;
  return (
    32 +
    utf8ByteLength(value.id) +
    (value.mbContentRating ? utf8ByteLength(value.mbContentRating) : 0) +
    (value.isAdult === undefined ? 0 : 1)
  );
};

const isMissingDocumentError = (error: unknown): boolean =>
  error instanceof SourceHttpError && error.status === 404;

export class AtsumaruClient {
  private readonly filtersCache = new AsyncKeyedCache<"filters", AtsumaruFilterOptions>({
    ttlMs: 30 * 60_000,
    maxEntries: 1,
    maxWeight: FILTER_CACHE_MAX_WEIGHT,
    weigh: filterOptionsWeight,
  });
  private readonly searchCache = new AsyncKeyedCache<string, string>({
    ttlMs: 30_000,
    maxEntries: 64,
    maxWeight: SEARCH_CACHE_MAX_BYTES,
    weigh: utf8ByteLength,
  });
  private readonly homeCache = new AsyncKeyedCache<string, string>({
    ttlMs: 60_000,
    maxEntries: 96,
    maxWeight: HOME_CACHE_MAX_BYTES,
    weigh: utf8ByteLength,
  });
  private readonly seriesCache = new AsyncKeyedCache<string, string>({
    ttlMs: 120_000,
    maxEntries: 64,
    maxWeight: SERIES_CACHE_MAX_BYTES,
    weigh: utf8ByteLength,
  });
  private readonly chaptersCache = new AsyncKeyedCache<string, string>({
    ttlMs: 60_000,
    maxEntries: 48,
    maxWeight: CHAPTERS_CACHE_MAX_BYTES,
    weigh: utf8ByteLength,
  });
  private readonly ratingCache = new AsyncKeyedCache<string, AtsumaruRatingDocument | null>({
    ttlMs: 120_000,
    maxEntries: RATING_CACHE_MAX_ENTRIES,
    maxWeight: RATING_CACHE_MAX_BYTES,
    weigh: ratingWeight,
  });

  constructor(private readonly transport: AtsumaruTransport = defaultTransport) {}

  private async cachedJson<K, T>(
    cache: AsyncKeyedCache<K, string>,
    key: K,
    url: string,
    map: (value: unknown) => T,
  ): Promise<T> {
    return cache.getMapped(
      key,
      () => this.transport.fetchText({ url, method: "GET" }),
      (body) => map(decodeJson(body)),
    );
  }

  async getFilterOptions(): Promise<AtsumaruFilterOptions> {
    const filters = await this.filtersCache.get("filters", async () =>
      parseAvailableFilters(
        decodeJson(
          await this.transport.fetchText(
            { url: AVAILABLE_FILTERS_URL, method: "GET" },
            { maxBytes: AVAILABLE_FILTERS_MAX_BYTES },
          ),
        ),
      ),
    );
    return cloneFilterOptions(filters);
  }

  async getSearchPage(
    query: SearchQuery<AtsumaruSearchMetadata>,
    sortingOption: SortingOption | undefined,
    page: number,
  ): Promise<AtsumaruCatalogPage> {
    const url = buildSearchUrl(query, sortingOption, page);
    return this.cachedJson(this.searchCache, url, url, parseSearchResponse);
  }

  async getHomePage(
    feed: AtsumaruHomeFeed,
    offset: number,
    preferences: AtsumaruDiscoveryPreferences,
  ): Promise<AtsumaruCatalogPage> {
    const limit = Math.max(1, Math.min(100, Math.trunc(preferences.limit ?? 24)));
    const url = buildHomeUrl(feed, { ...preferences, offset, limit });
    const { page, rawCount } = await this.cachedJson(this.homeCache, url, url, (value) => {
      const page = parseFeedResponse(value);
      const rawCount =
        value && typeof value === "object" && Array.isArray((value as { items?: unknown }).items)
          ? (value as { items: unknown[] }).items.length
          : 0;
      return { page, rawCount };
    });
    return {
      items: page.items,
      offset,
      nextOffset: offset + rawCount,
      hasNextPage: rawCount >= limit,
    };
  }

  private getMangaPageValue(mangaId: string): Promise<unknown> {
    const url = buildMangaPageUrl(mangaId);
    return this.cachedJson(this.seriesCache, url, url, (value) => value);
  }

  private getMangaRatingValue(mangaId: string): Promise<AtsumaruRatingDocument | null> {
    const url = buildMangaDocumentUrl(mangaId);
    const result = this.ratingCache.get(url, async () => {
      try {
        const body = await this.transport.fetchText(
          { url, method: "GET" },
          { maxBytes: MANGA_RATING_MAX_BYTES },
        );
        const parsed = parseMangaRatingDocument(decodeJson(body), mangaId);
        if (!parsed) throw new Error("Atsumaru rating document identity was invalid.");
        return parsed;
      } catch (error: unknown) {
        // A direct document 404 is a stable absence and is safe to retain.
        // Other transport failures reject the cache entry and remain retryable.
        if (isMissingDocumentError(error)) return null;
        throw error;
      }
    });
    // The rating lookup is auxiliary: any non-404 failure falls back to the
    // page result. AsyncKeyedCache evicts rejected loaders, so outages remain
    // retryable rather than becoming cached absences.
    return result.catch(() => null);
  }

  /** Resolve Atsumaru IDs replaced by an upstream merge without changing Paperback's library ID. */
  private async resolveCanonicalMangaId(sourceManga: SourceManga): Promise<string> {
    const stored = canonicalMangaIdFromManga(sourceManga);
    if (stored) return stored;

    const original = sourceManga.mangaId;
    const primaryTitle = sourceManga.mangaInfo.primaryTitle;
    const titleKeys = new Set(
      [primaryTitle, ...(sourceManga.mangaInfo.secondaryTitles ?? [])]
        .map(titleIdentity)
        .filter(Boolean),
    );
    if (titleKeys.size === 0) return original;

    try {
      const page = await this.getSearchPage(
        { title: primaryTitle, metadata: { adult: "all" } },
        undefined,
        1,
      );
      const matches = new Set(
        page.items
          .filter((item) => titleKeys.has(titleIdentity(item.title)))
          .map((item) => validMangaId(item.mangaId))
          .filter((mangaId): mangaId is string => mangaId !== undefined),
      );
      if (matches.has(original)) return original;
      if (matches.size === 1) return [...matches][0]!;
    } catch {
      // Resolution is a compatibility aid. Keep the persisted ID usable when
      // search is temporarily unavailable or returns a changed contract.
    }
    return original;
  }

  async getMangaDetails(mangaId: string): Promise<SourceManga> {
    const pageUrl = buildMangaPageUrl(mangaId);
    const [pageValue, ratingDocument] = await Promise.all([
      this.getMangaPageValue(mangaId),
      this.getMangaRatingValue(mangaId),
    ]);
    try {
      const sourceManga = parseMangaPage(pageValue, mangaId, ratingDocument);
      const scanlatorMetadata = encodeScanlatorMetadata(pageValue);
      if (scanlatorMetadata) {
        sourceManga.mangaInfo.additionalInfo = {
          ...sourceManga.mangaInfo.additionalInfo,
          [SCANLATOR_METADATA_KEY]: scanlatorMetadata,
        };
      }
      sourceManga.mangaInfo.additionalInfo = {
        ...sourceManga.mangaInfo.additionalInfo,
        [CANONICAL_MANGA_ID_KEY]: sourceManga.mangaId,
      };
      return sourceManga;
    } catch (error: unknown) {
      // Page parsing now happens after the two coalesced loads, so retain the
      // previous retry behavior explicitly when the raw detail is malformed.
      this.seriesCache.delete(pageUrl);
      throw error;
    }
  }

  async getChapters(
    sourceManga: SourceManga,
    _sinceDate?: Date,
    includeAlternates = true,
  ): Promise<Chapter[]> {
    const mangaId = await this.resolveCanonicalMangaId(sourceManga);
    const chaptersUrl = buildAllChaptersUrl(mangaId);
    const chaptersValue = await this.cachedJson(
      this.chaptersCache,
      chaptersUrl,
      chaptersUrl,
      (value) => value,
    );
    let chapters: Chapter[];
    try {
      chapters = parseChapters(
        chaptersValue,
        chapterSourceManga(sourceManga),
        scanlatorsFromManga(sourceManga),
      ).map((chapter) => ({
        ...chapter,
        additionalInfo: {
          ...chapter.additionalInfo,
          [CANONICAL_MANGA_ID_KEY]: mangaId,
        },
      }));
    } catch (error: unknown) {
      this.chaptersCache.delete(chaptersUrl);
      throw error;
    }
    if (!includeAlternates) chapters = newestTranslationPerNumber(chapters);
    // Atsumaru's createdAt is an import timestamp, not a reliable first-seen
    // timestamp. Newly added and restored series can receive complete chapter
    // backfills dated before Paperback's sinceDate. Always return the endpoint's
    // authoritative list so Paperback can merge those backfilled chapters.
    return chapters;
  }

  async getChapterDetails(chapter: Chapter): Promise<ChapterDetails> {
    const contentType = chapter.sourceManga.mangaInfo.contentType?.toLowerCase();
    const medium = chapter.additionalInfo?.medium?.toLowerCase();
    const format = chapter.sourceManga.mangaInfo.additionalInfo?.format?.toLowerCase();
    const isNovel =
      contentType === "novel" ||
      medium === "novel" ||
      (!contentType && !medium && format === "novel");
    const mangaId =
      canonicalMangaIdFromChapter(chapter) ??
      (await this.resolveCanonicalMangaId(chapter.sourceManga));
    const url = isNovel
      ? buildNovelChapterUrl(mangaId, chapter.chapterId)
      : buildChapterUrl(mangaId, chapter.chapterId);
    const body = await this.transport.fetchText({ url, method: "GET" });
    const value = decodeJson(body);
    return isNovel ? parseNovelChapter(value, chapter) : parseComicChapter(value, chapter);
  }

  async resolvePastedUrl(query: string): Promise<PagedResults<SearchResultItem> | undefined> {
    const mangaId = parseMangaUrl(query) ?? parseNovelUrl(query);
    if (!mangaId) return undefined;
    try {
      return { items: [searchItem(await this.getMangaDetails(mangaId))] };
    } catch {
      return undefined;
    }
  }

  invalidateCaches(): void {
    this.filtersCache.clear();
    this.searchCache.clear();
    this.homeCache.clear();
    this.seriesCache.clear();
    this.chaptersCache.clear();
    this.ratingCache.clear();
  }
}
