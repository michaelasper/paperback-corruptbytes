import type { JSONObject, Request, SearchQuery, SortingOption } from "@paperback/types";

import { fetchSourceTextResponse, requestContext, SourceHttpError } from "../shared/http.js";
import { isHttpsUrlForHosts } from "../shared/url.js";

export const DOMAIN = "https://vortexscans.org";
export const API_URL = "https://api.vortexscans.org/api";
export const PAGE_SIZE = 18;

export interface SearchMetadata extends JSONObject {
  status?: string[];
  type?: string[];
  direction?: string[];
  genres?: Record<string, "included" | "excluded">;
}

type QueryValue = boolean | number | string | null | undefined;

export const normalizeSearchTerm = (value: string): string =>
  value
    .trim()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ");

export const buildApiUrl = (endpoint: string, query: Record<string, QueryValue> = {}): string => {
  const cleanEndpoint = endpoint.replace(/^\/+|\/+$/g, "");
  const parameters = Object.entries(query)
    .filter((entry): entry is [string, boolean | number | string] => entry[1] != null)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join("&");

  return `${API_URL}/${cleanEndpoint}${parameters ? `?${parameters}` : ""}`;
};

export const buildSearchUrl = (
  query: SearchQuery<SearchMetadata>,
  sortingOption: SortingOption | undefined,
  page: number,
): string => {
  const metadata = query.metadata;
  const genres = Object.entries(metadata?.genres ?? {});
  const includedGenres = genres.filter(([, state]) => state === "included").map(([id]) => id);
  const excludedGenres = genres.filter(([, state]) => state === "excluded").map(([id]) => id);

  return buildApiUrl("query", {
    page: Math.max(1, Math.trunc(page)),
    perPage: PAGE_SIZE,
    searchTerm: normalizeSearchTerm(query.title ?? "") || undefined,
    orderBy: sortingOption?.id || undefined,
    orderDirection: metadata?.direction?.[0] || undefined,
    seriesStatus: metadata?.status?.[0] || undefined,
    seriesType: metadata?.type?.[0] || undefined,
    genreIds: includedGenres.length > 0 ? includedGenres.join(",") : undefined,
    excludedGenreIds: excludedGenres.length > 0 ? excludedGenres.join(",") : undefined,
  });
};

export const parseSeriesUrl = (value: string): string | undefined => {
  const match = value
    .trim()
    .match(/^https?:\/\/(?:www\.)?vortexscans\.org\/series\/([^/?#]+)\/?(?:[?#].*)?$/i);
  if (!match?.[1]) return undefined;

  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
};

const RESPONSE_HOSTS = new Set(["api.vortexscans.org"]);
const RESPONSE_OPTIONS = {
  sourceName: "Vortex Scans",
  isResponseUrlAllowed: (requestUrl: string, responseUrl: string) =>
    isHttpsUrlForHosts(requestUrl, RESPONSE_HOSTS) &&
    isHttpsUrlForHosts(responseUrl, RESPONSE_HOSTS),
} as const;
const HTML_DOCUMENT = /^\s*(?:<!doctype\s+html\b|<html\b|<head\b|<body\b|<title\b)/i;

export const fetchJSON = async <T>(request: Request): Promise<T> => {
  let body: string;
  try {
    ({ body } = await fetchSourceTextResponse(request, RESPONSE_OPTIONS));
  } catch (error: unknown) {
    if (!(error instanceof SourceHttpError)) throw error;
    if (error.status === 401 || error.status === 403) {
      throw new Error("Log in to Vortex Scans from the extension settings and try again.");
    }
    if (error.status === 404) throw new Error("Content not found.");
    if (error.status === 429)
      throw new Error("Vortex Scans rate limit reached. Please wait and try again.");
    throw error;
  }

  try {
    if (HTML_DOCUMENT.test(body)) {
      throw new Error("Vortex Scans returned HTML instead of JSON.");
    }
    return JSON.parse(body) as T;
  } catch (error: unknown) {
    if (error instanceof Error && /returned HTML instead of JSON/i.test(error.message)) {
      throw error;
    }
    throw new Error(`Failed to parse JSON from ${requestContext(request.url)}.`, { cause: error });
  }
};
