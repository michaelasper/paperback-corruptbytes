import type { Request, SearchQuery, SortingOption } from "@paperback/types";

import { fetchSourceJson, fetchSourceText, requestContext } from "../shared/http.js";
import { decodePaperbackIdComponent, encodePaperbackIdComponent } from "../shared/ids.js";
import { isHttpsUrlForHosts } from "../shared/url.js";
import type { HomeFeedId, ThunderSearchMetadata } from "./models.js";

export const DOMAIN = "https://en-thunderscans.com";
export const COMICS_URL = `${DOMAIN}/comics/`;
export const AJAX_URL = `${DOMAIN}/wp-admin/admin-ajax.php`;
export const PROFILE_URL = `${DOMAIN}/profile/`;
export const LOGIN_URL = `${DOMAIN}/login/`;

const FORM_HEADERS = { "content-type": "application/x-www-form-urlencoded; charset=UTF-8" };

export const normalizeSearchTerm = (value: string): string =>
  value
    .trim()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ");

const parameterString = (entries: [string, string | undefined][]): string =>
  entries
    .filter((entry): entry is [string, string] => entry[1] !== undefined && entry[1] !== "")
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");

export const hasAdvancedFilters = (metadata: ThunderSearchMetadata | undefined): boolean =>
  Boolean(
    metadata?.status?.length ||
    metadata?.type?.length ||
    Object.keys(metadata?.genres ?? {}).length,
  );

export const buildDirectoryUrl = (
  query: SearchQuery<ThunderSearchMetadata>,
  sortingOption: SortingOption | undefined,
  page: number,
): string => {
  const currentPage = Math.max(1, Math.trunc(page));
  const title = normalizeSearchTerm(query.title ?? "");
  if (title) {
    const base = currentPage > 1 ? `${COMICS_URL}page/${currentPage}/` : COMICS_URL;
    return `${base}?${parameterString([["s", title]])}`;
  }

  const metadata = query.metadata;
  const genres = Object.entries(metadata?.genres ?? {})
    .filter(([, state]) => state === "included")
    .map(([id]) => id)
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
  const entries: [string, string | undefined][] = [
    ["page", currentPage > 1 ? String(currentPage) : undefined],
    ...genres.map((genre): [string, string] => ["genre[]", genre]),
    ["status", metadata?.status?.[0]],
    ["type", metadata?.type?.[0]],
    ["order", sortingOption?.id],
  ];
  const queryString = parameterString(entries);
  return `${COMICS_URL}${queryString ? `?${queryString}` : ""}`;
};

export const parseSeriesUrl = (value: string): string | undefined => {
  const match = value
    .trim()
    .match(/^https:\/\/en-thunderscans\.com\/comics\/([^/?#]+)\/?(?:[?#].*)?$/i);
  if (!match?.[1]) return undefined;
  return encodePaperbackIdComponent(decodePaperbackIdComponent(match[1]));
};

const safeSlug = (value: string): string | undefined => {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const decoded = decodePaperbackIdComponent(trimmed);
  return /[/?#\\\0]|^\.{1,2}$/.test(decoded) ? undefined : decoded;
};

export const buildMangaUrl = (mangaId: string): string => {
  const normalized = mangaId.trim();
  if (/^\d+$/.test(normalized)) return `${DOMAIN}/?p=${normalized}`;
  const slug = safeSlug(normalized);
  if (!slug) throw new Error("Thunder Scans manga ID is invalid.");
  return `${COMICS_URL}${encodeURIComponent(slug)}/`;
};

export const buildChapterFallbackUrl = (
  mangaSlug: string,
  chapterId: string,
): string | undefined => {
  const slug = safeSlug(mangaSlug);
  const chapter = chapterId.trim();
  if (!slug || !/^\d+(?:\.\d+)?$/.test(chapter)) return undefined;
  return `${DOMAIN}/${encodeURIComponent(slug)}-chapter-${chapter.replaceAll(".", "-")}/`;
};

const formRequest = (entries: [string, string][]): Request => ({
  url: AJAX_URL,
  method: "POST",
  headers: { ...FORM_HEADERS },
  body: parameterString(entries),
});

export const buildAutocompleteRequest = (title: string): Request =>
  formRequest([
    ["action", "ts_ac_do_search"],
    ["ts_ac_query", normalizeSearchTerm(title)],
  ]);

export const buildLoadMoreRequest = (
  feed: Extract<HomeFeedId, "latestComics" | "latestNovels">,
  page: number,
): Request => {
  const currentPage = String(Math.max(1, Math.trunc(page)));
  return feed === "latestComics"
    ? formRequest([
        ["action", "load_more_manga_posts"],
        ["page", currentPage],
      ])
    : formRequest([
        ["action", "load_more_novel_posts"],
        ["novel_page", currentPage],
      ]);
};

const RESPONSE_HOSTS = new Set(["en-thunderscans.com"]);
const RESPONSE_OPTIONS = {
  sourceName: "Thunder Scans",
  isResponseUrlAllowed: (requestUrl: string, responseUrl: string) =>
    isHttpsUrlForHosts(requestUrl, RESPONSE_HOSTS) &&
    isHttpsUrlForHosts(responseUrl, RESPONSE_HOSTS),
} as const;
const AUTH_FAILURE = /request failed with status (?:401|403)\./i;
const signInError = (): Error =>
  new Error("Sign in to Thunder Scans from the extension settings and try again.");

export const fetchText = async (request: Request): Promise<string> => {
  try {
    return await fetchSourceText(request, RESPONSE_OPTIONS);
  } catch (error: unknown) {
    if (error instanceof Error && AUTH_FAILURE.test(error.message)) {
      throw signInError();
    }
    throw error;
  }
};

export const fetchJSON = async <T = unknown>(request: Request): Promise<T> => {
  try {
    return await fetchSourceJson<T>(request, RESPONSE_OPTIONS);
  } catch (error: unknown) {
    if (error instanceof Error && AUTH_FAILURE.test(error.message)) {
      throw signInError();
    }
    if (error instanceof Error && /returned invalid JSON\./i.test(error.message)) {
      throw new Error(
        `Failed to parse JSON from ${requestContext(request.url)}: ${error.message}`,
        { cause: error },
      );
    }
    throw error;
  }
};
