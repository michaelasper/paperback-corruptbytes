import type { Request, SearchQuery, SortingOption } from "@paperback/types";

import { fetchSourceText, requestContext } from "../shared/http.js";
import {
  decodePaperbackIdComponent,
  encodePaperbackIdComponent,
  validateOpaqueId,
} from "../shared/ids.js";
import { isHttpsUrlForHosts } from "../shared/url.js";
import type { QiMangaSearchMetadata } from "./models.js";

export const DOMAIN = "https://qimanga.com";
export const API_DOMAIN = "https://api.qimanga.com";
export const API_BASE_URL = `${API_DOMAIN}/api/v1`;

export const CATALOG_PAGE_SIZE = 100;
export const LATEST_PAGE_SIZE = 40;

const API_HOSTS = new Set([API_DOMAIN.replace("https://", "")]);

type QueryValue = boolean | number | string | undefined;

export const normalizeSearchTerm = (value: string): string =>
  value
    .trim()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ");

const queryString = (values: [string, QueryValue][]): string =>
  values
    .filter((entry): entry is [string, boolean | number | string] => entry[1] !== undefined)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join("&");

const hasUnpairedSurrogate = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      if (index + 1 >= value.length) return true;
      const following = value.charCodeAt(index + 1);
      if (following < 0xdc00 || following > 0xdfff) return true;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }
  return false;
};

export const normalizePageNumber = (page: number): number => {
  const normalized = Math.trunc(page);
  return Number.isSafeInteger(normalized) && normalized >= 1 && normalized <= 10_000
    ? normalized
    : 1;
};

const MAX_SERIES_SLUG_LENGTH = 256;
const MAX_SEARCH_TERM_LENGTH = 256;
const VALID_STATUSES = new Set(["ONGOING", "COMPLETED", "HIATUS", "DROPPED", "CANCELLED"]);
const VALID_TYPES = new Set(["MANGA", "MANHWA", "MANHUA", "NOVEL"]);
const VALID_SORTS = new Set(["latest", "newest", "popular", "alphabetical"]);

const filterSlug = (value: string | undefined): string | undefined => {
  const normalized = value?.trim();
  return normalized && isValidSeriesSlug(normalized) ? normalized : undefined;
};

const enumValue = (value: string | undefined, allowed: ReadonlySet<string>): string | undefined => {
  const normalized = value?.trim();
  return normalized && allowed.has(normalized) ? normalized : undefined;
};

/** Series slug coming from an API response; must survive use as both an ID and URL segment. */
export const isValidSeriesSlug = (value: string): boolean => {
  const validated = validateOpaqueId(value, MAX_SERIES_SLUG_LENGTH);
  return validated === value && encodePaperbackIdComponent(value).length <= MAX_SERIES_SLUG_LENGTH;
};

export const seriesIdToSlug = (mangaId: string): string => {
  const decoded = decodePaperbackIdComponent(mangaId);
  if (!isValidSeriesSlug(decoded)) throw new Error("Qi Manga series ID is invalid.");
  return decoded;
};

export const seriesSlugToId = (slug: string): string => {
  if (!isValidSeriesSlug(slug)) throw new Error("Qi Manga series slug is invalid.");
  return encodePaperbackIdComponent(slug);
};

export const buildBrowseUrl = (
  query: SearchQuery<QiMangaSearchMetadata>,
  sortingOption: SortingOption | undefined,
  page: number,
): string => {
  const metadata = query.metadata ?? {};
  const parameters = queryString([
    ["page", normalizePageNumber(page)],
    ["perPage", CATALOG_PAGE_SIZE],
    ["genre", filterSlug(metadata.genre)],
    ["status", enumValue(metadata.status, VALID_STATUSES)],
    ["type", enumValue(metadata.type, VALID_TYPES)],
    ["sort", enumValue(sortingOption?.id ?? metadata.sort, VALID_SORTS) ?? "latest"],
  ]);
  return `${API_BASE_URL}/series?${parameters}`;
};

export const buildSearchUrl = (query: SearchQuery<QiMangaSearchMetadata>, page: number): string => {
  const title = normalizeSearchTerm(query.title ?? "");
  if (title.length > MAX_SEARCH_TERM_LENGTH) {
    throw new Error("Qi Manga search term is too long.");
  }
  if (hasUnpairedSurrogate(title)) {
    throw new Error("Qi Manga search term is invalid.");
  }
  const parameters = queryString([
    ["page", normalizePageNumber(page)],
    ["perPage", CATALOG_PAGE_SIZE],
    ["q", title || undefined],
  ]);
  return `${API_BASE_URL}/series/search?${parameters}`;
};

export const buildLatestUrl = (page: number): string =>
  `${API_BASE_URL}/home/latest?${queryString([
    ["page", normalizePageNumber(page)],
    ["perPage", LATEST_PAGE_SIZE],
  ])}`;

export const buildHomeUrl = (): string => `${API_BASE_URL}/home`;

export const buildGenresUrl = (): string => `${API_BASE_URL}/series/genres`;

export const buildSeriesUrl = (mangaId: string): string =>
  `${API_BASE_URL}/series/${encodePaperbackIdComponent(seriesIdToSlug(mangaId))}`;

export const buildChaptersUrl = (mangaId: string, page: number, sort: "asc" | "desc"): string =>
  `${API_BASE_URL}/series/${encodePaperbackIdComponent(seriesIdToSlug(mangaId))}/chapters?${queryString(
    [
      ["page", normalizePageNumber(page)],
      ["perPage", CATALOG_PAGE_SIZE],
      ["sort", sort],
    ],
  )}`;

export const buildChapterUrl = (mangaId: string, chapterId: string): string => {
  const chapterSlug = validateOpaqueId(decodePaperbackIdComponent(chapterId));
  if (!chapterSlug || encodePaperbackIdComponent(chapterSlug).length > 256) {
    throw new Error("Qi Manga chapter ID is invalid.");
  }
  return `${API_BASE_URL}/series/${encodePaperbackIdComponent(seriesIdToSlug(mangaId))}/chapters/${encodePaperbackIdComponent(chapterSlug)}`;
};

export const parseSeriesUrl = (value: string): string | undefined => {
  if (value.length > 2_048) return undefined;
  const match = value
    .trim()
    .match(/^https?:\/\/(?:www\.)?qimanga\.com\/series\/([^/?#]+)(?:\/[^?#]*)?(?:[?#].*)?$/i);
  if (!match?.[1]) return undefined;
  let slug: string | undefined;
  try {
    slug = decodeURIComponent(match[1]);
  } catch {
    return undefined;
  }
  if (!slug || !isValidSeriesSlug(slug)) return undefined;
  return seriesSlugToId(slug);
};

export const isApiRequestUrl = (value: string): boolean => isHttpsUrlForHosts(value, API_HOSTS);

const MEDIA_HOSTS = new Set([
  "media.qimanga.com",
  "media.qiscans.org",
  "media.qimanhwa.com",
  "media.ezmanga.org",
  "media.quantumscans.org",
]);

/** API-provided media must use an observed HTTPS CDN and never carry account cookies. */
export const isNeutralMediaUrl = (value: string): boolean => isHttpsUrlForHosts(value, MEDIA_HOSTS);

const RESPONSE_OPTIONS = {
  sourceName: "Qi Manga",
  maxBodyBytes: 4 * 1_024 * 1_024,
  isResponseUrlAllowed: (requestUrl: string, responseUrl: string) =>
    isHttpsUrlForHosts(requestUrl, API_HOSTS) && isHttpsUrlForHosts(responseUrl, API_HOSTS),
} as const;

export const fetchText = (request: Request): Promise<string> =>
  fetchSourceText(request, RESPONSE_OPTIONS);

export const parseJsonDocument = <T>(body: string, requestUrl: string): T => {
  if (/^\s*(?:<!doctype\s+html|<html\b)/i.test(body)) {
    throw new Error(`Qi Manga returned HTML instead of JSON for ${requestContext(requestUrl)}.`);
  }
  try {
    return JSON.parse(body) as T;
  } catch (error: unknown) {
    throw new Error(`Qi Manga returned invalid JSON for ${requestContext(requestUrl)}.`, {
      cause: error,
    });
  }
};

export const fetchJson = async <T>(request: Request): Promise<T> =>
  parseJsonDocument<T>(await fetchText(request), request.url);
