import {
  URL as PaperbackURL,
  type Request,
  type SearchQuery,
  type SortingOption,
} from "@paperback/types";

import { fetchSourceJson, fetchSourceText, SourceHttpError } from "./http.js";
import { decodePaperbackIdComponent, encodePaperbackIdComponent, validateOpaqueId } from "./ids.js";
import type {
  NovelDashRouteKind,
  NovelDashSearchMetadata,
  NovelDashSite,
} from "./noveldash-models.js";
import { isHttpsUrlForHosts } from "./url.js";

export const NOVELDASH_CATALOG_PAGE_SIZE = 24;
export const NOVELDASH_CHAPTER_PAGE_SIZE = 100;

const COMIC_TYPES = new Set(["COMIC", "MANGA", "MANHUA", "MANHWA", "WEBTOON"]);

type QueryValue = boolean | number | string | undefined;

const encodeQueryComponent = (value: string): string =>
  encodeURIComponent(value).replace(
    /[!'()*~]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );

export const routeKindForSeriesType = (value: unknown): NovelDashRouteKind =>
  typeof value === "string" && COMIC_TYPES.has(value.trim().toUpperCase()) ? "comic" : "novel";

export const encodeNovelDashMangaId = (kind: NovelDashRouteKind, slug: string): string => {
  const validSlug = validateOpaqueId(slug);
  if (!validSlug) throw new Error("The series slug is invalid.");
  return encodePaperbackIdComponent(`${kind}@${validSlug}`);
};

export const decodeNovelDashMangaId = (
  mangaId: string,
): { kind: NovelDashRouteKind; slug: string } => {
  const decoded = decodePaperbackIdComponent(mangaId);
  const separator = decoded.indexOf("@");
  const kind = decoded.slice(0, separator);
  const slug = validateOpaqueId(decoded.slice(separator + 1));
  if ((kind !== "comic" && kind !== "novel") || !slug) {
    throw new Error("The series ID is invalid.");
  }
  return { kind, slug };
};

const queryString = (values: readonly [string, QueryValue][]): string =>
  values
    .filter((entry): entry is [string, boolean | number | string] => entry[1] !== undefined)
    .map(([key, value]) => `${encodeQueryComponent(key)}=${encodeQueryComponent(String(value))}`)
    .join("&");

const selectedGenres = (
  genres: Record<string, "included" | "excluded"> | undefined,
  state: "included" | "excluded",
): string | undefined => {
  const values = Object.entries(genres ?? {})
    .filter(([, selection]) => selection === state)
    .map(([slug]) => slug.trim())
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));
  return values.length > 0 ? values.join(",") : undefined;
};

const selectedValues = (values: readonly string[] | undefined): string | undefined => {
  const selected = [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))].sort(
    (left, right) => left.localeCompare(right),
  );
  return selected.length > 0 ? selected.join(",") : undefined;
};

const boundedChapterCount = (value: number | undefined, fallback: number): number =>
  value === undefined || !Number.isFinite(value)
    ? fallback
    : Math.max(0, Math.min(100_000, Math.trunc(value)));

export const normalizeNovelDashSearchTerm = (value: string): string =>
  value
    .trim()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ");

export const buildNovelDashCatalogUrl = (
  site: NovelDashSite,
  query: SearchQuery<NovelDashSearchMetadata>,
  sortingOption: SortingOption | undefined,
  page: number,
  limit = NOVELDASH_CATALOG_PAGE_SIZE,
): string => {
  const metadata = query.metadata;
  const hasChapterRange = metadata?.chapterRangeEnabled === true;
  const parameters = queryString([
    ["page", Math.max(1, Math.trunc(page))],
    ["limit", Math.max(1, Math.min(100, Math.trunc(limit)))],
    ["contentMode", "all"],
    ["q", normalizeNovelDashSearchTerm(query.title ?? "") || undefined],
    ["genre", selectedGenres(metadata?.genres, "included")],
    ["exgenre", selectedGenres(metadata?.genres, "excluded")],
    ["type", selectedValues(metadata?.types)],
    ["status", selectedValues(metadata?.statuses)],
    ["origin", selectedValues(metadata?.origins)],
    ["sort", sortingOption?.id || "updated"],
    ["sale", metadata?.onSale ? true : undefined],
    ["ch_min", hasChapterRange ? boundedChapterCount(metadata?.minimumChapters, 0) : undefined],
    [
      "ch_max",
      hasChapterRange ? boundedChapterCount(metadata?.maximumChapters, 100_000) : undefined,
    ],
  ]);
  return `${site.domain}/api/series?${parameters}`;
};

export const buildNovelDashSeriesUrl = (site: NovelDashSite, mangaId: string, page = 1): string => {
  const { kind, slug } = decodeNovelDashMangaId(mangaId);
  const suffix = page > 1 ? `?page=${Math.max(1, Math.trunc(page))}` : "";
  return `${site.domain}/series/${kind}/${encodeURIComponent(slug)}${suffix}`;
};

export const buildNovelDashChapterUrl = (
  site: NovelDashSite,
  mangaId: string,
  chapterNumber: string,
): string => {
  const { kind, slug } = decodeNovelDashMangaId(mangaId);
  const validNumber = chapterNumber.trim();
  if (!/^\d+(?:\.\d+)?$/.test(validNumber)) {
    throw new Error("The chapter number is invalid.");
  }
  return `${site.domain}/series/${kind}/${encodeURIComponent(slug)}/chapter/${encodeURIComponent(validNumber)}`;
};

export const parseNovelDashSeriesUrl = (site: NovelDashSite, value: string): string | undefined => {
  let parsed: PaperbackURL;
  try {
    parsed = new PaperbackURL(value.trim());
  } catch {
    return undefined;
  }
  if (
    parsed.protocol.toLowerCase().replace(/:$/, "") !== "https" ||
    (parsed.hostname !== site.host && parsed.hostname !== `www.${site.host}`) ||
    parsed.username ||
    parsed.password ||
    (parsed.port && parsed.port !== "443")
  ) {
    return undefined;
  }
  const match = parsed.path.match(/^\/series\/(comic|novel)\/([^/]+)(?:\/chapter\/[^/]+)?\/?$/i);
  if (!match?.[1] || !match[2]) return undefined;
  try {
    return encodeNovelDashMangaId(
      match[1].toLowerCase() as NovelDashRouteKind,
      decodeURIComponent(match[2]),
    );
  } catch {
    return undefined;
  }
};

const responseOptions = (site: NovelDashSite, maxBodyBytes = 8 * 1_024 * 1_024) => {
  const hosts = new Set([site.host, `www.${site.host}`]);
  return {
    sourceName: site.name,
    maxBodyBytes,
    isResponseUrlAllowed: (requestUrl: string, responseUrl: string) =>
      isHttpsUrlForHosts(requestUrl, hosts) && isHttpsUrlForHosts(responseUrl, hosts),
  } as const;
};

const mapHttpError = (site: NovelDashSite, error: unknown): never => {
  if (!(error instanceof SourceHttpError)) throw error;
  if (error.status === 401 || error.status === 403) {
    throw new Error(`Sign in to ${site.name} from extension settings and try again.`);
  }
  if (error.status === 404) throw new Error(`${site.name} content was not found.`);
  if (error.status === 429) {
    throw new Error(`${site.name} rate limit reached. Please wait and try again.`);
  }
  throw error;
};

export const fetchNovelDashText = async (
  site: NovelDashSite,
  request: Request,
  maxBodyBytes?: number,
): Promise<string> => {
  try {
    return await fetchSourceText(request, responseOptions(site, maxBodyBytes));
  } catch (error: unknown) {
    return mapHttpError(site, error);
  }
};

export const fetchNovelDashJson = async <T>(
  site: NovelDashSite,
  request: Request,
  maxBodyBytes?: number,
): Promise<T> => {
  try {
    return await fetchSourceJson<T>(request, responseOptions(site, maxBodyBytes));
  } catch (error: unknown) {
    return mapHttpError(site, error);
  }
};
