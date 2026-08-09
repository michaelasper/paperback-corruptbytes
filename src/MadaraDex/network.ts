import {
  URL as PaperbackURL,
  type Request,
  type SearchQuery,
  type SortingOption,
} from "@paperback/types";

import { fetchSourceText, scheduleTextResponse, SourceHttpError } from "../shared/http.js";
import { isHttpsUrlForHosts } from "../shared/url.js";
import type { MadaraSearchMetadata } from "./models.js";

export const DOMAIN = "https://madaradex.org";
export const ROOT_URL = `${DOMAIN}/`;
export const DIRECTORY_URL = `${DOMAIN}/title/`;
export const AJAX_URL = `${DOMAIN}/wp-admin/admin-ajax.php`;
export const AUTH_REFRESH_URL = AJAX_URL;

const normalize = (value: string | undefined): string =>
  (value ?? "")
    .trim()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ");

const numericId = (value: string): string => {
  const result = value.trim();
  if (!/^\d+$/.test(result)) throw new Error("MadaraDex manga IDs must be numeric.");
  return result;
};

const selected = (values: string[] | undefined): string[] =>
  [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))].sort((left, right) =>
    left.localeCompare(right, undefined, { numeric: true }),
  );

const hasAdvancedFilters = (metadata: MadaraSearchMetadata | undefined): boolean =>
  Boolean(
    metadata &&
    (selected(metadata.genres).length > 0 ||
      normalize(metadata.author) ||
      normalize(metadata.artist) ||
      normalize(metadata.release) ||
      (metadata.adult && metadata.adult !== "all") ||
      selected(metadata.status).length > 0),
  );

export const buildCatalogUrl = (
  query: SearchQuery<MadaraSearchMetadata>,
  sortingOption: SortingOption | undefined,
  page: number,
): string => {
  const currentPage = Math.max(1, Math.trunc(page));
  const title = normalize(query.title);
  const metadata = query.metadata;
  const search = Boolean(title || hasAdvancedFilters(metadata));
  const path = search
    ? currentPage === 1
      ? "/"
      : `/page/${currentPage}/`
    : currentPage === 1
      ? "/title/"
      : `/title/page/${currentPage}/`;
  const queryItems: Record<string, string | string[]> = {};

  if (search) {
    queryItems.s = title;
    queryItems.post_type = "wp-manga";
    const genres = selected(metadata?.genres);
    if (genres.length > 0) queryItems["genre[]"] = genres;
    if (metadata?.genreCondition === "and") queryItems.op = "1";
    const author = normalize(metadata?.author);
    const artist = normalize(metadata?.artist);
    const release = normalize(metadata?.release);
    if (author) queryItems.author = author;
    if (artist) queryItems.artist = artist;
    if (release) queryItems.release = release;
    if (metadata?.adult === "none") queryItems.adult = "0";
    if (metadata?.adult === "only") queryItems.adult = "1";
    const statuses = selected(metadata?.status);
    if (statuses.length > 0) queryItems["status[]"] = statuses;
  }

  const sorting = sortingOption?.id || (search ? "relevance" : "latest");
  if (sorting !== "relevance") queryItems.m_orderby = sorting;
  return new PaperbackURL(DOMAIN).setPath(path).setQueryItems(queryItems).toString();
};

export const buildMangaUrl = (mangaId: string): string => `${DOMAIN}/?p=${numericId(mangaId)}`;

export const parseMangaUrl = (value: string): string | undefined => {
  try {
    const url = new PaperbackURL(value.trim());
    if (url.protocol !== "https" && url.protocol !== "http") return undefined;
    if (url.username || url.password) return undefined;
    if (url.hostname.toLowerCase().replace(/^www\./, "") !== "madaradex.org") return undefined;
    const rawPostId = url.queryItems?.p;
    const postId = (Array.isArray(rawPostId) ? rawPostId[0] : rawPostId)?.trim();
    return postId && /^\d+$/.test(postId) ? postId : undefined;
  } catch {
    return undefined;
  }
};

const formRequest = (body: string): Request => ({
  url: AJAX_URL,
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8" },
  body,
});

export const buildChapterAjaxRequests = (mangaId: string): Request[] => {
  const id = numericId(mangaId);
  return [
    formRequest(`action=manga_get_chapters&manga=${encodeURIComponent(id)}`),
    formRequest(`action=ajax_chap&post_id=${encodeURIComponent(id)}`),
  ];
};

export const buildRefreshRequest = (): Request => ({
  ...formRequest("action=mdx_auth_refresh"),
  headers: {
    ...formRequest("").headers,
    "x-mdx-auth-refresh": "1",
    "cache-control": "no-store",
  },
});

const RESPONSE_HOSTS = new Set(["madaradex.org", "www.madaradex.org"]);
const RESPONSE_OPTIONS = {
  sourceName: "MadaraDex",
  isResponseUrlAllowed: (requestUrl: string, responseUrl: string) =>
    isHttpsUrlForHosts(requestUrl, RESPONSE_HOSTS) &&
    isHttpsUrlForHosts(responseUrl, RESPONSE_HOSTS),
} as const;

export const fetchTextResponse = async (request: Request) =>
  scheduleTextResponse(request, RESPONSE_OPTIONS);

export const fetchText = async (request: Request): Promise<string> => {
  try {
    return await fetchSourceText(request, RESPONSE_OPTIONS);
  } catch (error: unknown) {
    if (!(error instanceof SourceHttpError)) throw error;
    if (error.status === 404) throw new Error("MadaraDex content not found.");
    if (error.status === 429) {
      throw new Error("MadaraDex rate limit reached. Please wait and try again.");
    }
    throw new Error(`MadaraDex request failed with status ${error.status}.`);
  }
};
