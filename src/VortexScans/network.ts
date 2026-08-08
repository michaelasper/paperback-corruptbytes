import type { JSONObject, Request, SearchQuery, SortingOption } from "@paperback/types";

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

const errorMessageFromBody = (body: string): string | undefined => {
  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: unknown } | string;
      message?: unknown;
    };
    if (typeof parsed.message === "string" && parsed.message.trim()) {
      return parsed.message.trim().slice(0, 240);
    }
    if (typeof parsed.error === "string" && parsed.error.trim()) {
      return parsed.error.trim().slice(0, 240);
    }
    if (typeof parsed.error === "object" && typeof parsed.error?.message === "string") {
      return parsed.error.message.trim().slice(0, 240);
    }
  } catch {
    // Non-JSON error bodies are intentionally ignored.
  }
  return undefined;
};

export const fetchJSON = async <T>(request: Request): Promise<T> => {
  const [response, buffer] = await Application.scheduleRequest(request);
  const body = Application.arrayBufferToUTF8String(buffer);

  if (response.status === 401 || response.status === 403) {
    throw new Error("Log in to Vortex Scans from the extension settings and try again.");
  }
  if (response.status === 404) {
    throw new Error(`Content not found: ${request.url}`);
  }
  if (response.status === 429) {
    throw new Error("Vortex Scans rate limit reached. Please wait and try again.");
  }
  if (response.status < 200 || response.status >= 300) {
    const detail = errorMessageFromBody(body);
    throw new Error(
      `Vortex Scans request failed with status ${response.status}${detail ? `: ${detail}` : ""}`,
    );
  }

  try {
    return JSON.parse(body) as T;
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse JSON from ${request.url}: ${reason}`, { cause: error });
  }
};
