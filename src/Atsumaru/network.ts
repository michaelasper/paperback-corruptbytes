import {
  URL as PaperbackURL,
  type Request,
  type Response,
  type SearchQuery,
  type SortingOption,
} from "@paperback/types";

import {
  DEFAULT_MAX_RESPONSE_BYTES,
  fetchSourceJson,
  fetchSourceText,
  fetchSourceTextResponse,
  requestContext,
} from "../shared/http.js";
import {
  decodePaperbackIdComponent,
  encodePaperbackIdComponent,
  validateOpaqueId,
} from "../shared/ids.js";
import { isHttpsUrlForHosts } from "../shared/url.js";
import type {
  AtsumaruAdultPolicy,
  AtsumaruDiscoveryPreferences,
  AtsumaruHomeFeed,
  AtsumaruSearchMetadata,
  AtsumaruTimeframe,
} from "./models.js";

export const DOMAIN = "https://atsu.moe";
export const CDN_DOMAIN = "https://cdn.atsu.moe";
export const ROOT_URL = `${DOMAIN}/`;
export const PAGE_SIZE = 30;
const MAX_TYPESENSE_FILTER_CLAUSES = 50;
const MAX_DYNAMIC_QUERY_LENGTH = 3_900;
/** Metadata responses are bounded before decoding to avoid untrusted payload growth. */
export const DEFAULT_MAX_BODY_BYTES = DEFAULT_MAX_RESPONSE_BYTES;

export const AVAILABLE_FILTERS_URL = `${DOMAIN}/api/explore/availableFilters`;
export const MANGA_PAGE_URL = `${DOMAIN}/api/manga/page`;
export const ALL_CHAPTERS_URL = `${DOMAIN}/api/manga/allChapters`;
export const READ_CHAPTER_URL = `${DOMAIN}/api/read/chapter`;
export const READ_NOVEL_CHAPTER_URL = `${DOMAIN}/api/read/novelChapter`;
export const TYPESENSE_MANGA_URL = `${DOMAIN}/collections/manga/documents/search`;
export const TYPESENSE_MANGA_DOCUMENTS_URL = `${DOMAIN}/collections/manga/documents`;
/** The direct rating document is deliberately kept far below the general metadata cap. */
export const MANGA_RATING_MAX_BYTES = 1_024;

const SEARCH_FIELDS =
  "id,title,englishTitle,poster,posterSmall,posterMedium,type,medium,isAdult,status,year,mbRating,popularity,dateAdded,mbContentRating,views,releaseDate,chapterCount,officialTranslation,genreIds,tagIds,authors,otherNames,acronyms";
const QUERY_BY = "title,englishTitle,otherNames,authors,acronyms";
const QUERY_BY_WEIGHTS = "4,3,2,1,1";
const NUM_TYPOS = "4,3,2,1,0";
const PREFIX = "true,true,true,true,false";
const INFIX = "off,off,fallback,off,off";
const CONTENT_RATINGS = ["Safe", "Suggestive", "Erotica", "Pornographic"] as const;
const MEDIUMS = ["Comic", "Novel"] as const;
const TIMEFRAMES = new Set<AtsumaruTimeframe>(["daily", "weekly", "monthly", "all"]);
const HOME_FEEDS = new Set<AtsumaruHomeFeed>([
  "hotUpdates",
  "recentlyUpdated",
  "popular",
  "rising",
  "hotArrivals",
  "mostBookmarked",
  "genreSpotlight",
  "mostTalkedAbout",
  "recentlyAdded",
  "bingeWorthy",
  "mostPolarizing",
  "hiddenGems",
  "topRated",
]);
const TIMEFRAME_FEEDS = new Set<AtsumaruHomeFeed>(["popular", "mostBookmarked", "mostTalkedAbout"]);
const FIRST_PARTY_HOSTS = new Set(["atsu.moe", "www.atsu.moe"]);

type QueryValue = string | number | boolean | undefined;

const encodeQueryComponent = (value: string): string =>
  encodeURIComponent(value).replace(
    /[!'()*~]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );

const queryString = (entries: [string, QueryValue][]): string =>
  entries
    .filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined)
    .map(([key, value]) => `${encodeQueryComponent(key)}=${encodeQueryComponent(String(value))}`)
    .join("&");

const assertDynamicQueryLength = (query: string, context: "search" | "discovery"): string => {
  if (query.length > MAX_DYNAMIC_QUERY_LENGTH) {
    throw new Error(`Atsumaru ${context} query is too large. Reduce tag selections and try again.`);
  }
  return query;
};

export const normalizeSearchTerm = (value: string | undefined): string =>
  (value ?? "")
    .trim()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ");

/**
 * Validate and decode one opaque Atsumaru identifier. IDs are not slugs: no
 * title-derived fallback or case folding belongs at this boundary.
 */
const opaqueId = (value: string, label: string): string => {
  const decoded = decodePaperbackIdComponent(value);
  const valid = validateOpaqueId(decoded);
  if (!valid) {
    throw new Error(`Atsumaru ${label} is invalid.`);
  }
  return valid;
};

const routeComponent = (value: string, label: string): string =>
  encodePaperbackIdComponent(opaqueId(value, label));

const queryId = (value: string, label: string): string => opaqueId(value, label);

const MANGA_RATING_FIELDS = "id,mbContentRating,isAdult";

export const buildMangaUrl = (mangaId: string): string =>
  `${DOMAIN}/manga/${routeComponent(mangaId, "manga ID")}`;

export const buildNovelUrl = (novelId: string): string =>
  `${DOMAIN}/novel/${routeComponent(novelId, "novel ID")}`;

const parseRouteUrl = (value: string, route: "manga" | "novel"): string | undefined => {
  try {
    // PaperbackURL is deliberately used instead of the browser global URL;
    // it is available in Paperback's runtime and does not normalize paths.
    const parsed = new PaperbackURL(value.trim());
    const protocol = parsed.protocol.toLowerCase().replace(/:$/, "");
    const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
    if (
      (protocol !== "http" && protocol !== "https") ||
      !FIRST_PARTY_HOSTS.has(hostname) ||
      parsed.username ||
      parsed.password ||
      parsed.port
    ) {
      return undefined;
    }
    const match = parsed.path.match(new RegExp(`^/${route}/([^/]+?)/?$`, "i"));
    if (!match?.[1]) return undefined;
    const decoded = opaqueId(match[1], `${route} ID`);
    return encodePaperbackIdComponent(decoded);
  } catch {
    return undefined;
  }
};

export const parseMangaUrl = (value: string): string | undefined => parseRouteUrl(value, "manga");
export const parseNovelUrl = (value: string): string | undefined => parseRouteUrl(value, "novel");
export const parseSeriesUrl = parseMangaUrl;

export const buildMangaPageUrl = (mangaId: string): string =>
  `${MANGA_PAGE_URL}?${queryString([["id", queryId(mangaId, "manga ID")]])}`;

/** Build the reduced Typesense document lookup used for authoritative ratings. */
export const buildMangaDocumentUrl = (mangaId: string): string =>
  `${TYPESENSE_MANGA_DOCUMENTS_URL}/${routeComponent(mangaId, "manga ID")}?${queryString([
    ["include_fields", MANGA_RATING_FIELDS],
  ])}`;

export const buildAvailableFiltersUrl = (): string => AVAILABLE_FILTERS_URL;

export const buildAvailableFiltersRequest = (): Request => ({
  url: AVAILABLE_FILTERS_URL,
  method: "GET",
});

export const buildAllChaptersUrl = (mangaId: string): string =>
  `${ALL_CHAPTERS_URL}?${queryString([["mangaId", queryId(mangaId, "manga ID")]])}`;

export const buildChapterUrl = (mangaId: string, chapterId: string): string =>
  `${READ_CHAPTER_URL}?${queryString([
    ["mangaId", queryId(mangaId, "manga ID")],
    ["chapterId", queryId(chapterId, "chapter ID")],
  ])}`;

export const buildNovelChapterUrl = (mangaId: string, chapterId: string): string =>
  `${READ_NOVEL_CHAPTER_URL}?${queryString([
    ["mangaId", queryId(mangaId, "manga ID")],
    ["chapterId", queryId(chapterId, "chapter ID")],
  ])}`;

export const buildMangaPageRequest = (mangaId: string): Request => ({
  url: buildMangaPageUrl(mangaId),
  method: "GET",
});

export const buildAllChaptersRequest = (mangaId: string): Request => ({
  url: buildAllChaptersUrl(mangaId),
  method: "GET",
});

export const buildChapterRequest = (mangaId: string, chapterId: string): Request => ({
  url: buildChapterUrl(mangaId, chapterId),
  method: "GET",
});

export const buildNovelChapterRequest = (mangaId: string, chapterId: string): Request => ({
  url: buildNovelChapterUrl(mangaId, chapterId),
  method: "GET",
});

const typesenseLiteral = (value: string): string =>
  `\`${value.replace(/\\/g, "\\\\").replace(/`/g, "\\`")}\``;

const values = (items: string[] | undefined): string[] => [
  ...new Set((items ?? []).map((value) => value.trim()).filter(Boolean)),
];

const includeFilter = (field: string, items: string[] | undefined): string | undefined => {
  const selected = values(items);
  return selected.length > 0
    ? `${field}:=[${selected.map(typesenseLiteral).join(",")}]`
    : undefined;
};

const excludeFilter = (field: string, items: string[] | undefined): string | undefined => {
  const selected = values(items);
  return selected.length > 0
    ? `${field}:!=[${selected.map(typesenseLiteral).join(",")}]`
    : undefined;
};

const triState = (
  taxonomy: Record<string, "included" | "excluded"> | undefined,
  state: "included" | "excluded",
): string[] =>
  Object.entries(taxonomy ?? {})
    .filter(([, value]) => value === state)
    .map(([id]) => id.trim())
    .filter(Boolean);

const metadataYears = (metadata: AtsumaruSearchMetadata | undefined): string | undefined => {
  if (metadata?.years?.length) {
    const years = metadata.years
      .filter((year) => Number.isFinite(year))
      .map((year) => Math.trunc(year));
    if (years.length === 1) return `releaseYear:=[${years[0]}]`;
    if (years.length > 1) {
      const lower = Math.min(...years);
      const upper = Math.max(...years);
      return `releaseYear:=[${lower}..${upper}]`;
    }
  }
  const from = metadata?.yearFrom ?? metadata?.releaseYearFrom ?? metadata?.yearRange?.from;
  const to = metadata?.yearTo ?? metadata?.releaseYearTo ?? metadata?.yearRange?.to;
  const min = metadata?.yearRange?.min;
  const max = metadata?.yearRange?.max;
  const lower = Number.isFinite(from)
    ? Math.trunc(from as number)
    : Number.isFinite(min)
      ? Math.trunc(min as number)
      : undefined;
  const upper = Number.isFinite(to)
    ? Math.trunc(to as number)
    : Number.isFinite(max)
      ? Math.trunc(max as number)
      : undefined;
  if (lower !== undefined && upper !== undefined) return `releaseYear:=[${lower}..${upper}]`;
  if (lower !== undefined) return `releaseYear:>=${lower}`;
  if (upper !== undefined) return `releaseYear:<=${upper}`;
  return undefined;
};

const mediumFilter = (items: string[] | undefined): string | undefined => {
  const selected = values(items);
  if (selected.length === 0 || MEDIUMS.every((medium) => selected.includes(medium)))
    return undefined;
  if (selected.includes("Comic")) {
    return excludeFilter(
      "medium",
      MEDIUMS.filter((medium) => !selected.includes(medium)),
    );
  }
  return includeFilter("medium", selected);
};

const contentRatingFilter = (items: string[] | undefined): string | undefined => {
  const selected = values(items);
  if (selected.length === 0 || CONTENT_RATINGS.every((rating) => selected.includes(rating))) {
    return undefined;
  }
  // Typesense's `!=` operator matches documents where the field is missing.
  // Use a positive match so unrated documents cannot leak into an explicitly
  // selected content-rating subset.
  return includeFilter("mbContentRating", selected);
};

const adultFilter = (policy: AtsumaruAdultPolicy | undefined): string | undefined => {
  switch (policy) {
    case "all":
      return undefined;
    case "adult":
    case "only":
      return "isAdult:=true";
    case "safe":
      return "isAdult:=false";
    default:
      // Safe mode is the conservative default. Selecting a content-rating
      // does not implicitly switch the adult catalog; callers must opt into
      // `all` or `adult` explicitly.
      return "isAdult:=false";
  }
};

const sortId = (sortingOption: SortingOption | undefined): string | undefined =>
  sortingOption?.id?.trim();

const sortValue = (id: string | undefined): string | undefined => {
  switch (id) {
    case "title":
      return "title:asc";
    case "views":
    case "popularity":
    case "most-viewed":
      return "views:desc";
    case "trending":
      return "trending:desc";
    case "dateAdded":
    case "createdAt":
    case "recently-added":
      return "dateAdded:desc";
    case "releaseDate":
    case "released":
      return "releaseDate:desc";
    case "mbRating":
    case "topRated":
    case "top-rated":
      return "mbRating:desc";
    default:
      return undefined;
  }
};

const buildFilterBy = (
  metadata: AtsumaruSearchMetadata | undefined,
  sortingOption: SortingOption | undefined,
  hasText: boolean,
): string => {
  const filters: string[] = [];
  for (const id of triState(metadata?.genres, "included"))
    filters.push(`genreIds:=${typesenseLiteral(id)}`);
  const excludedGenres = excludeFilter("genreIds", [
    ...triState(metadata?.genres, "excluded"),
    ...(metadata?.excludeGenres ?? []),
  ]);
  if (excludedGenres) filters.push(excludedGenres);
  for (const id of triState(metadata?.tags, "included"))
    filters.push(`tagIds:=${typesenseLiteral(id)}`);
  const excludedTags = excludeFilter("tagIds", [
    ...triState(metadata?.tags, "excluded"),
    ...(metadata?.excludeTags ?? []),
  ]);
  if (excludedTags) filters.push(excludedTags);
  const types = includeFilter("type", metadata?.types);
  if (types) filters.push(types);
  const mediums = mediumFilter(metadata?.mediums);
  if (mediums) filters.push(mediums);
  const statuses = includeFilter("status", metadata?.statuses);
  if (statuses) filters.push(statuses);
  const years = metadataYears(metadata);
  if (years) filters.push(years);
  if (
    metadata?.minChapters !== undefined &&
    Number.isFinite(metadata.minChapters) &&
    metadata.minChapters > 0
  ) {
    filters.push(`chapterCount:>=${Math.trunc(metadata.minChapters)}`);
  }
  if (metadata?.officialTranslation === true) filters.push("officialTranslation:=true");
  const adult = adultFilter(metadata?.adult ?? metadata?.adultPolicy);
  if (adult) filters.push(adult);
  const ratings = contentRatingFilter(metadata?.contentRatings);
  if (ratings) filters.push(ratings);

  const currentSort = sortId(sortingOption);
  if (currentSort === "topRated" || currentSort === "top-rated") filters.push("mbRating:>0");
  if (currentSort === "popularity" || currentSort === "most-viewed" || (!hasText && !currentSort)) {
    filters.push("views:>0");
  }
  // This guard is intentionally last and unconditional: hidden records must
  // not become visible because a caller supplied a custom filter expression.
  filters.push("hidden:!=true");
  if (filters.length > MAX_TYPESENSE_FILTER_CLAUSES) {
    throw new Error(
      "Atsumaru search has too many simultaneous filters. Reduce included tag or genre selections and try again.",
    );
  }
  return filters.join(" && ");
};

export const buildSearchUrl = (
  query: SearchQuery<AtsumaruSearchMetadata>,
  sortingOption: SortingOption | undefined,
  page: number,
): string => {
  const title = normalizeSearchTerm(query.title);
  const hasText = title.length > 0;
  const currentPage = Math.max(1, Math.trunc(Number.isFinite(page) ? page : 1));
  const selectedSort = sortId(sortingOption);
  const params: [string, QueryValue][] = [
    ["q", hasText ? title : "*"],
    ["query_by", QUERY_BY],
    ["query_by_weights", QUERY_BY_WEIGHTS],
    ["num_typos", NUM_TYPOS],
    ["prefix", PREFIX],
    ["include_fields", SEARCH_FIELDS],
    ["filter_by", buildFilterBy(query.metadata, sortingOption, hasText)],
    ["page", currentPage],
    ["per_page", PAGE_SIZE],
  ];
  if (hasText) params.push(["infix", INFIX]);
  const explicitSort = sortValue(selectedSort);
  if (explicitSort && selectedSort !== "relevance") params.push(["sort_by", explicitSort]);
  else if (!hasText) params.push(["sort_by", "views:desc"]);
  const encodedQuery = assertDynamicQueryLength(queryString(params), "search");
  return `${TYPESENSE_MANGA_URL}?${encodedQuery}`;
};

export const buildSearchRequest = (
  query: SearchQuery<AtsumaruSearchMetadata>,
  sortingOption: SortingOption | undefined,
  page: number,
): Request => ({
  url: buildSearchUrl(query, sortingOption, page),
  method: "GET",
});

const boundedOffset = (value: number | undefined): number =>
  value === undefined || !Number.isFinite(value) ? 0 : Math.max(0, Math.trunc(value));

const boundedLimit = (value: number | undefined): number =>
  value === undefined || !Number.isFinite(value)
    ? PAGE_SIZE
    : Math.max(1, Math.min(100, Math.trunc(value)));

const csv = (items: string[] | undefined): string | undefined => {
  const selected = values(items);
  return selected.length > 0 ? selected.join(",") : undefined;
};

const homeQuery = (
  feed: AtsumaruHomeFeed,
  options: AtsumaruDiscoveryPreferences,
): [string, QueryValue][] => {
  if (!HOME_FEEDS.has(feed)) throw new Error(`Atsumaru home feed is invalid: ${feed}.`);
  const entries: [string, QueryValue][] = [
    ["offset", boundedOffset(options.offset)],
    ["limit", boundedLimit(options.limit)],
    ["adult", options.adult === true || options.catalog === "adult" ? "1" : undefined],
    ["types", csv(options.types)],
    ["mediums", csv(options.mediums)],
    ["excludedTags", csv(options.excludedTags)],
  ];
  const timeframe =
    options.timeframe ??
    (feed === "popular"
      ? options.popularTimeframe
      : feed === "mostBookmarked"
        ? options.bookmarksTimeframe
        : feed === "mostTalkedAbout"
          ? options.talkedAboutTimeframe
          : undefined);
  if (timeframe !== undefined) {
    if (!TIMEFRAMES.has(timeframe)) throw new Error("Atsumaru timeframe is invalid.");
    if (TIMEFRAME_FEEDS.has(feed)) entries.push(["timeframe", timeframe]);
  }
  // recentlyUpdated and genreSpotlight explicitly do not accept includedTags
  // in the live API; all other public rails do.
  if (feed !== "recentlyUpdated" && feed !== "genreSpotlight") {
    entries.push(["includedTags", csv(options.includedTags)]);
  }
  return entries;
};

export const buildHomeUrl = (
  feed: AtsumaruHomeFeed,
  options: AtsumaruDiscoveryPreferences = {},
): string => {
  if (feed === "genreSpotlight") {
    const genre = options.genre ?? options.genreId ?? options.genreSpotlight;
    if (!genre?.trim()) throw new Error("Atsumaru genre spotlight requires a genre.");
    const query = assertDynamicQueryLength(
      queryString([["genre", genre.trim()], ...homeQuery(feed, options)]),
      "discovery",
    );
    return `${DOMAIN}/api/home2/${feed}?${query}`;
  }
  const query = assertDynamicQueryLength(queryString(homeQuery(feed, options)), "discovery");
  return `${DOMAIN}/api/home2/${feed}?${query}`;
};

export const buildHomeRequest = (
  feed: AtsumaruHomeFeed,
  options: AtsumaruDiscoveryPreferences = {},
): Request => ({
  url: buildHomeUrl(feed, options),
  method: "GET",
});

export interface AtsumaruFetchBodyOptions {
  /** Override the metadata limit for deliberately larger chapter envelopes. */
  maxBytes?: number;
}

type FetchOptions = AtsumaruFetchBodyOptions | number | undefined;

const maxBodyBytes = (options: FetchOptions): number => {
  const candidate = typeof options === "number" ? options : options?.maxBytes;
  return candidate === undefined || !Number.isFinite(candidate)
    ? DEFAULT_MAX_BODY_BYTES
    : Math.max(1, Math.trunc(candidate));
};

const sourceOptions = (options: FetchOptions) => ({
  sourceName: "Atsumaru",
  maxBodyBytes: maxBodyBytes(options),
  isResponseUrlAllowed: (requestUrl: string, responseUrl: string) =>
    isHttpsUrlForHosts(requestUrl, FIRST_PARTY_HOSTS) &&
    isHttpsUrlForHosts(responseUrl, FIRST_PARTY_HOSTS),
});

export const fetchTextResponse = async (
  request: Request,
  options?: FetchOptions,
): Promise<{ response: Response; body: string }> => {
  return fetchSourceTextResponse(request, sourceOptions(options));
};

export const fetchText = async (request: Request, options?: FetchOptions): Promise<string> => {
  return fetchSourceText(request, sourceOptions(options));
};

const looksLikeChallengeHtml = (body: string): boolean =>
  /<\s*(?:!doctype\s+html|html|head|body|title)\b/i.test(body) &&
  /just a moment|checking your browser|verify you are human|cloudflare|challenge-platform/i.test(
    body,
  );

const sanitizeFailureDetail = (value: string): string => {
  let result = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    result +=
      codePoint !== undefined && (codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f))
        ? " "
        : character;
    if (result.length >= 400) break;
  }
  return result.replace(/\s+/gu, " ").trim().slice(0, 200) || "unknown API error";
};

const boundedFailureDetail = (value: unknown): string => {
  const visited = new Set<object>();
  let candidate = value;
  for (let depth = 0; depth < 16; depth += 1) {
    if (typeof candidate === "string") return sanitizeFailureDetail(candidate);
    if (!candidate || typeof candidate !== "object" || visited.has(candidate)) {
      return "unknown API error";
    }
    visited.add(candidate);
    const record = candidate as { error?: unknown; message?: unknown };
    candidate = record.error ?? record.message;
  }
  return "unknown API error";
};

/** Reject API-level success:false envelopes while retaining the parsed value on success. */
export const assertAtsumaruApiSuccess = <T>(value: T, context = "Atsumaru API"): T => {
  const envelope =
    value && typeof value === "object"
      ? (value as { success?: unknown; name?: unknown })
      : undefined;
  if (
    envelope &&
    (envelope.success === false ||
      (typeof envelope.name === "string" && envelope.name.trim() === "ZodError"))
  ) {
    throw new Error(`${context} reported failure: ${boundedFailureDetail(value)}.`);
  }
  return value;
};

export const ensureAtsumaruSuccess = assertAtsumaruApiSuccess;
export const assertApiSuccess = assertAtsumaruApiSuccess;

export const fetchJson = async <T = unknown>(
  request: Request,
  options?: FetchOptions,
): Promise<T> => {
  const context = requestContext(request.url);
  let value: T;
  try {
    value = await fetchSourceJson<T>(request, sourceOptions(options));
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (/returned HTML instead of JSON/i.test(message) || looksLikeChallengeHtml(message)) {
      throw new Error(
        `Atsumaru returned a Cloudflare HTML challenge instead of JSON for ${context}.`,
        { cause: error },
      );
    }
    if (/returned invalid JSON/i.test(message)) {
      throw new Error(`Atsumaru returned invalid JSON for ${context}.`, { cause: error });
    }
    throw error;
  }
  return assertAtsumaruApiSuccess(value, `Atsumaru API ${context}`);
};

/** Compatibility aliases used by clients that follow the other source modules. */
export const fetchJSON = fetchJson;
export const buildMangaRequest = buildMangaPageRequest;
export const buildHomeFeedUrl = buildHomeUrl;
export const buildHomeFeedRequest = buildHomeRequest;
