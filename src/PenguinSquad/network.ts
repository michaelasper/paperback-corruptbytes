import { URL as PaperbackURL, type Request } from "@paperback/types";

import { fetchSourceText } from "../shared/http.js";
import { decodePaperbackIdComponent, encodePaperbackIdComponent } from "../shared/ids.js";
import { isHttpsUrlForHosts, resolveHttpsUrl } from "../shared/url.js";
import type { ChapterId, PenguinChapterRef, PenguinPageMetadata, SeriesId } from "./models.js";
import { MAX_CATALOG_PAGES, MAX_SEARCH_TERM_LENGTH, PENGUIN_SITE, SITE_HOSTS } from "./site.js";

export const DOMAIN = PENGUIN_SITE.domain;

const RESPONSE_OPTIONS = {
  sourceName: PENGUIN_SITE.name,
  isResponseUrlAllowed: (requestUrl: string, responseUrl: string) =>
    isHttpsUrlForHosts(requestUrl, SITE_HOSTS) && isHttpsUrlForHosts(responseUrl, SITE_HOSTS),
} as const;

const SERIES_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CHAPTER_SLUG = /^chapter-\d{1,7}(?:-[a-z0-9]+)*$/;
const MAX_SLUG_LENGTH = 200;
const SERIES_PATH = /^\/novels\/([^/?#]+)$/;
const CHAPTER_PATH = /^\/novels\/([^/?#]+)\/([^/?#]+)$/;
/** Reject control characters and lone surrogates without a host-dependent regex flag. */
const hasUnsafeText = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
};

export const isSeriesSlug = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= MAX_SLUG_LENGTH &&
  SERIES_SLUG.test(value) &&
  !hasUnsafeText(value);

export const isChapterSlug = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= MAX_SLUG_LENGTH &&
  CHAPTER_SLUG.test(value) &&
  !hasUnsafeText(value);

export const encodeSeriesId = (slug: unknown): SeriesId => {
  if (!isSeriesSlug(slug)) throw new Error("Penguin Squad series ID is invalid.");
  return encodePaperbackIdComponent(slug) as SeriesId;
};

export const decodeSeriesId = (value: unknown): string => {
  let slug: unknown;
  try {
    slug = typeof value === "string" ? decodePaperbackIdComponent(value) : undefined;
  } catch {
    slug = undefined;
  }
  if (!isSeriesSlug(slug)) throw new Error("Penguin Squad series ID is invalid.");
  return slug;
};

export const encodeChapterId = (seriesSlug: string, chapterSlug: string): ChapterId => {
  if (!isSeriesSlug(seriesSlug) || !isChapterSlug(chapterSlug)) {
    throw new Error("Penguin Squad chapter ID is invalid.");
  }
  return encodePaperbackIdComponent(`${seriesSlug}/${chapterSlug}`) as ChapterId;
};

export const decodeChapterId = (value: unknown): PenguinChapterRef => {
  let decoded: string;
  try {
    decoded = typeof value === "string" ? decodePaperbackIdComponent(value) : "";
  } catch {
    throw new Error("Penguin Squad chapter ID is invalid.");
  }
  const separator = decoded.indexOf("/");
  const seriesSlug = decoded.slice(0, separator);
  const chapterSlug = decoded.slice(separator + 1);
  if (separator < 0 || !isSeriesSlug(seriesSlug) || !isChapterSlug(chapterSlug)) {
    throw new Error("Penguin Squad chapter ID is invalid.");
  }
  return {
    seriesId: encodeSeriesId(seriesSlug),
    chapterId: encodeChapterId(seriesSlug, chapterSlug),
  };
};

export const seriesSlugOf = (value: SeriesId): string => decodeSeriesId(value);

export const normalizePageNumber = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error("Penguin Squad page number is invalid.");
  }
  if (value > MAX_CATALOG_PAGES) throw new Error("Penguin Squad page number is too large.");
  return value;
};

/** Clamp a free-form term to the site search field's published limit. */
export const normalizeSearchTerm = (value: unknown): string => {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new Error("Penguin Squad search term is invalid.");
  const collapsed = value.replace(/\s+/gu, " ").trim();
  if (hasUnsafeText(collapsed)) {
    throw new Error("Penguin Squad search term is invalid.");
  }
  return collapsed.slice(0, MAX_SEARCH_TERM_LENGTH);
};

export const parsePageMetadata = (
  value: unknown,
  options: { query?: string } = {},
): PenguinPageMetadata & { page: number } => {
  if (value === undefined || value === null) return { page: 1 };
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Penguin Squad page metadata is invalid.");
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "page" && key !== "query") {
      throw new Error("Penguin Squad page metadata is invalid.");
    }
  }
  const page = normalizePageNumber(record["page"] ?? 1);
  const query = record["query"];
  if (query !== undefined) {
    const expected = options.query;
    if (expected === undefined || typeof query !== "string" || query !== expected) {
      throw new Error("Penguin Squad search continuation does not match this query.");
    }
  }
  return query === undefined ? { page } : { page, query };
};

export const buildCatalogUrl = (page: number): string => {
  const value = normalizePageNumber(page);
  return value === 1 ? `${DOMAIN}/novels` : `${DOMAIN}/novels?page=${value}`;
};

export const buildSearchUrl = (term: string): string => {
  const value = normalizeSearchTerm(term);
  return value ? `${DOMAIN}/search?q=${encodeURIComponent(value)}` : `${DOMAIN}/search`;
};

export const buildSeriesUrl = (seriesId: SeriesId): string => {
  const slug = decodeSeriesId(seriesId);
  return `${DOMAIN}/novels/${encodePaperbackIdComponent(slug)}`;
};

export const buildChapterUrl = (chapterId: ChapterId): string => {
  const decoded = decodePaperbackIdComponent(decodeChapterId(chapterId).chapterId);
  const [seriesSlug, chapterSlug] = decoded.split("/");
  return `${DOMAIN}/novels/${encodePaperbackIdComponent(seriesSlug ?? "")}/${encodePaperbackIdComponent(chapterSlug ?? "")}`;
};

const safeDecode = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return "";
  }
};

export const parseSitePath = (
  value: unknown,
): { seriesSlug: string; chapterSlug?: string } | undefined => {
  const absolute = resolveHttpsUrl(value, DOMAIN);
  if (!absolute || !isHttpsUrlForHosts(absolute, SITE_HOSTS)) return undefined;
  try {
    const parsed = new PaperbackURL(absolute);
    if (parsed.queryItems !== undefined) return undefined;
    const chapter = CHAPTER_PATH.exec(parsed.path);
    if (chapter?.[1] && chapter[2]) {
      const seriesSlug = safeDecode(chapter[1]);
      const chapterSlug = safeDecode(chapter[2]);
      return isSeriesSlug(seriesSlug) && isChapterSlug(chapterSlug)
        ? { seriesSlug, chapterSlug }
        : undefined;
    }
    const series = SERIES_PATH.exec(parsed.path);
    const seriesSlug = series?.[1] ? safeDecode(series[1]) : undefined;
    return isSeriesSlug(seriesSlug) ? { seriesSlug } : undefined;
  } catch {
    return undefined;
  }
};

export const parseSeriesUrl = (value: unknown): SeriesId | undefined => {
  const path = parseSitePath(value);
  return path && !path.chapterSlug ? encodeSeriesId(path.seriesSlug) : undefined;
};

export const parseChapterUrl = (value: unknown): PenguinChapterRef | undefined => {
  const path = parseSitePath(value);
  if (!path?.chapterSlug) return undefined;
  return {
    seriesId: encodeSeriesId(path.seriesSlug),
    chapterId: encodeChapterId(path.seriesSlug, path.chapterSlug),
  };
};

/** Resolve a pasted URL to a series, or to the parent series of a chapter URL. */
export const parsePastedUrl = (value: unknown): SeriesId | undefined => {
  const path = parseSitePath(typeof value === "string" ? value.trim() : value);
  return path ? encodeSeriesId(path.seriesSlug) : undefined;
};

/**
 * Validate a catalog continuation link against the request that produced it.
 * The returned page is the next server page, never a caller-supplied URL.
 */
export const parseContinuation = (
  value: unknown,
  options: { page: number; term?: string },
): number | undefined => {
  const absolute = resolveHttpsUrl(value, DOMAIN);
  if (!absolute || !isHttpsUrlForHosts(absolute, SITE_HOSTS)) {
    throw new Error("Penguin Squad pagination link was not trusted.");
  }
  let parsed: PaperbackURL;
  try {
    parsed = new PaperbackURL(absolute);
  } catch {
    throw new Error("Penguin Squad pagination link was not trusted.");
  }
  const expectedPath = options.term === undefined ? "/novels" : "/search";
  if (parsed.path !== expectedPath) {
    throw new Error("Penguin Squad pagination link was not trusted.");
  }
  const query = parsed.queryItems ?? {};
  const keys = Object.keys(query).sort();
  const expectedKeys = options.term === undefined ? ["page"] : ["page", "q"];
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new Error("Penguin Squad pagination link was not trusted.");
  }
  const rawPage = query["page"];
  if (typeof rawPage !== "string" || !/^[1-9]\d{0,5}$/.test(rawPage)) {
    throw new Error("Penguin Squad pagination link was not trusted.");
  }
  const page = normalizePageNumber(Number(rawPage));
  if (page !== options.page + 1) {
    throw new Error("Penguin Squad pagination link did not advance the catalog.");
  }
  if (options.term !== undefined && query["q"] !== options.term) {
    throw new Error("Penguin Squad pagination link did not preserve the search term.");
  }
  return page;
};

export const isSiteUrl = (value: unknown): value is string =>
  typeof value === "string" && isHttpsUrlForHosts(value, SITE_HOSTS);

export const fetchText = async (url: string): Promise<string> => {
  if (!isSiteUrl(url)) throw new Error("Penguin Squad request URL was not trusted.");
  const request: Request = { url, method: "GET" };
  return fetchSourceText(request, RESPONSE_OPTIONS);
};
