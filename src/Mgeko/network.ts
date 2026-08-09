import type { Request, SearchQuery, SortingOption } from "@paperback/types";

import { fetchSourceJson, fetchSourceText, requestContext } from "../shared/http.js";
import { decodePaperbackIdComponent, encodePaperbackIdComponent } from "../shared/ids.js";
import { isHttpsUrlForHosts } from "../shared/url.js";
import type { MgekoSearchMetadata } from "./models.js";

export const DOMAIN = "https://www.mgeko.cc";
export const ROOT_URL = `${DOMAIN}/`;
export const BROWSE_URL = `${DOMAIN}/browse-comics/data/`;

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

const selectedGenres = (
  genres: Record<string, "included" | "excluded"> | undefined,
  state: "included" | "excluded",
): string | undefined => {
  const selected = Object.entries(genres ?? {})
    .filter(([, value]) => value === state)
    .map(([id]) => id.trim())
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
  return selected.length > 0 ? selected.join(",") : undefined;
};

const boundedInteger = (value: number | undefined, fallback: number): number =>
  value === undefined || !Number.isFinite(value)
    ? fallback
    : Math.max(0, Math.min(9_999, Math.trunc(value)));

export const buildBrowseUrl = (
  query: SearchQuery<MgekoSearchMetadata>,
  sortingOption: SortingOption | undefined,
  page: number,
  safeMode: boolean,
): string => {
  const metadata = query.metadata;
  const chapterRange = metadata?.setChapterCount === true;
  const minRating = metadata?.minRating;
  const parameters = queryString([
    ["page", Math.max(1, Math.trunc(page))],
    ["sort", sortingOption?.id || "rating"],
    ["q", normalizeSearchTerm(query.title ?? "") || undefined],
    ["include_genres", selectedGenres(metadata?.genres, "included")],
    ["exclude_genres", selectedGenres(metadata?.genres, "excluded")],
    ["status", metadata?.status?.[0] || undefined],
    ["type", metadata?.type?.[0] || undefined],
    [
      "tags",
      metadata?.tags
        ?.split(",")
        .map((tag) => tag.trim())
        .filter(Boolean)
        .join(",") || undefined,
    ],
    ["min_chapters", chapterRange ? boundedInteger(metadata?.minChapters, 0) : undefined],
    ["max_chapters", chapterRange ? boundedInteger(metadata?.maxChapters, 9_999) : undefined],
    [
      "min_rating",
      minRating !== undefined && Number.isFinite(minRating) && minRating > 0
        ? Math.round(Math.min(5, Math.max(0, minRating)) * 10)
        : undefined,
    ],
    ["only_completed", metadata?.onlyCompleted ? 1 : undefined],
    ["only_translated", metadata?.onlyTranslated ? 1 : undefined],
    ["hide_on_break", metadata?.hideOnBreak ? 1 : undefined],
    ["safe_mode", safeMode ? 1 : 0],
  ]);
  return `${BROWSE_URL}?${parameters}`;
};

const routeComponent = (value: string, label: string): string => {
  const decoded = decodePaperbackIdComponent(value.trim());
  if (!decoded || /[/?#\\\0]/.test(decoded) || decoded === "." || decoded === "..") {
    throw new Error(`Mgeko ${label} is invalid.`);
  }
  return encodeURIComponent(decoded);
};

export const buildMangaUrl = (mangaId: string): string =>
  `${DOMAIN}/manga/${routeComponent(mangaId, "manga ID")}/`;

export const buildChaptersUrl = (mangaId: string): string =>
  `${DOMAIN}/manga/${routeComponent(mangaId, "manga ID")}/all-chapters/`;

export const buildChapterUrl = (chapterId: string): string =>
  `${DOMAIN}/reader/en/${routeComponent(chapterId, "chapter ID")}/`;

export const parseMangaUrl = (value: string): string | undefined => {
  const match = value
    .trim()
    .match(/^https?:\/\/(?:www\.)?mgeko\.cc\/manga\/([^/?#]+)\/?(?:[?#].*)?$/i);
  if (!match?.[1]) return undefined;
  return encodePaperbackIdComponent(decodePaperbackIdComponent(match[1]));
};

const RESPONSE_HOSTS = new Set(["mgeko.cc", "www.mgeko.cc"]);
const RESPONSE_OPTIONS = {
  sourceName: "Mgeko",
  isResponseUrlAllowed: (requestUrl: string, responseUrl: string) =>
    isHttpsUrlForHosts(requestUrl, RESPONSE_HOSTS) &&
    isHttpsUrlForHosts(responseUrl, RESPONSE_HOSTS),
} as const;

export const fetchText = async (request: Request): Promise<string> => {
  return fetchSourceText(request, RESPONSE_OPTIONS);
};

export const fetchJson = async <T>(request: Request): Promise<T> => {
  try {
    return await fetchSourceJson<T>(request, RESPONSE_OPTIONS);
  } catch (error: unknown) {
    if (error instanceof Error && /returned invalid JSON\./i.test(error.message)) {
      throw new Error(`Mgeko returned invalid JSON for ${requestContext(request.url)}.`, {
        cause: error,
      });
    }
    throw error;
  }
};
