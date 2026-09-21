import type { Request } from "@paperback/types";

import { fetchSourceJson, fetchSourceText, requestContext } from "../shared/http.js";
import { decodePaperbackIdComponent, encodePaperbackIdComponent } from "../shared/ids.js";
import { isHttpsUrlForHosts } from "../shared/url.js";
import { TEMPLE_SITE } from "./site.js";

export const DOMAIN = TEMPLE_SITE.domain;
export const ROOT_URL = `${DOMAIN}/`;
export const SEARCH_URL = `${DOMAIN}/api/search`;

const RESPONSE_HOSTS = new Set(["templetoons.com", "www.templetoons.com"]);
const RESPONSE_OPTIONS = {
  sourceName: "Temple",
  isResponseUrlAllowed: (requestUrl: string, responseUrl: string) =>
    isHttpsUrlForHosts(requestUrl, RESPONSE_HOSTS) &&
    isHttpsUrlForHosts(responseUrl, RESPONSE_HOSTS),
} as const;

export const fetchText = async (request: Request): Promise<string> =>
  fetchSourceText(request, RESPONSE_OPTIONS);

export const fetchJson = async <T>(request: Request): Promise<T> => {
  try {
    return await fetchSourceJson<T>(request, RESPONSE_OPTIONS);
  } catch (error: unknown) {
    if (error instanceof Error && /returned invalid JSON\./i.test(error.message)) {
      throw new Error(`Temple returned invalid JSON for ${requestContext(request.url)}.`, {
        cause: error,
      });
    }
    throw error;
  }
};

const routeComponent = (value: string, label: string): string => {
  const decoded = decodePaperbackIdComponent(value.trim());
  if (!decoded || /[/?#\\\0]/.test(decoded) || decoded === "." || decoded === "..") {
    throw new Error(`Temple ${label} is invalid.`);
  }
  return encodeURIComponent(decoded);
};

export const buildMangaUrl = (mangaId: string): string =>
  `${DOMAIN}/comic/${routeComponent(mangaId, "manga ID")}`;

export const buildChapterUrl = (chapterId: string): string => {
  const decoded = decodePaperbackIdComponent(chapterId.trim());
  const match = decoded.match(/^(.+)-chapter-(\d+(?:\.\d+)?)$/);
  if (!match?.[1] || !match[2]) throw new Error("Temple chapter ID is invalid.");
  return `${DOMAIN}/comic/${encodeURIComponent(match[1])}/chapter-${match[2]}`;
};

export const buildSearchUrl = (term: string, page: number): string =>
  `${SEARCH_URL}?q=${encodeURIComponent(term)}&page=${Math.max(1, Math.trunc(page))}&limit=15`;

export const buildCatalogUrl = (): string => `${DOMAIN}/comics`;

const slugFromComicHref = (href: string): string | undefined => {
  const match = href.match(
    /^https?:\/\/(?:www\.|templescan\.net)?(?:templetoons\.com|templescan\.net)\/comic\/([^/?#]+)\/?/i,
  );
  return match?.[1]?.trim().toLowerCase();
};

export const parseMangaUrl = (value: string): string | undefined => {
  const match = value
    .trim()
    .match(
      /^https?:\/\/(?:www\.)?(?:templetoons\.com|templescan\.net)\/comic\/([^/?#]+)\/?(?:[?#].*)?$/i,
    );
  if (!match?.[1]) return undefined;
  try {
    return encodePaperbackIdComponent(decodePaperbackIdComponent(match[1].toLowerCase()));
  } catch {
    return undefined;
  }
};

export const parseChapterUrl = (value: string): string | undefined => {
  const match = value
    .trim()
    .match(
      /^https?:\/\/(?:www\.)?(?:templetoons\.com|templescan\.net)\/comic\/([^/?#]+)\/chapter-(\d+(?:\.\d+)?)\/?(?:[?#].*)?$/i,
    );
  if (!match?.[1] || !match[2]) return undefined;
  try {
    const slug = `${match[1].toLowerCase()}-chapter-${match[2]}`;
    return encodePaperbackIdComponent(decodePaperbackIdComponent(slug));
  } catch {
    return undefined;
  }
};

export { slugFromComicHref };
