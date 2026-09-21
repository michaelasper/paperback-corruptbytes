import type { Request } from "@paperback/types";

import { fetchSourceText, requestContext } from "../shared/http.js";
import { decodePaperbackIdComponent, encodePaperbackIdComponent } from "../shared/ids.js";
import { isHttpsUrlForHosts } from "../shared/url.js";
import { ROKARI_SITE } from "./site.js";

export const DOMAIN = ROKARI_SITE.domain;
export const ROOT_URL = `${DOMAIN}/`;

const RESPONSE_HOSTS = new Set(["rokaricomics.com", "www.rokaricomics.com"]);
const RESPONSE_OPTIONS = {
  sourceName: "Rokari",
  isResponseUrlAllowed: (requestUrl: string, responseUrl: string) =>
    isHttpsUrlForHosts(requestUrl, RESPONSE_HOSTS) &&
    isHttpsUrlForHosts(responseUrl, RESPONSE_HOSTS),
} as const;

export const fetchText = async (request: Request): Promise<string> =>
  fetchSourceText(request, RESPONSE_OPTIONS);

const routeComponent = (value: string, label: string): string => {
  const decoded = decodePaperbackIdComponent(value.trim());
  if (!decoded || /[/?#\\\0]/.test(decoded) || decoded === "." || decoded === "..") {
    throw new Error(`Rokari ${label} is invalid.`);
  }
  return encodeURIComponent(decoded);
};

export const buildMangaUrl = (mangaId: string): string =>
  `${DOMAIN}/manga/${routeComponent(mangaId, "manga ID")}/`;

export const buildChapterUrl = (chapterId: string): string => {
  const decoded = decodePaperbackIdComponent(chapterId.trim());
  const match = decoded.match(/^(.+)-chapter-(\d+(?:\.\d+)?)$/);
  if (!match?.[1] || !match[2]) throw new Error("Rokari chapter ID is invalid.");
  return `${DOMAIN}/${encodeURIComponent(match[1])}-chapter-${match[2]}/`;
};

export const buildCatalogUrl = (order: "update" | "popular" = "update"): string =>
  `${DOMAIN}/manga/?order=${order}`;

export const buildSearchUrl = (term: string): string =>
  `${DOMAIN}/?s=${encodeURIComponent(term.trim())}`;

export const parseMangaUrl = (value: string): string | undefined => {
  const match = value
    .trim()
    .match(/^https?:\/\/(?:www\.)?rokaricomics\.com\/manga\/([^/?#]+)\/?(?:[?#].*)?$/i);
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
      /^https?:\/\/(?:www\.)?rokaricomics\.com\/([^/?#]+)-chapter-(\d+(?:\.\d+)?)\/?(?:[?#].*)?$/i,
    );
  if (!match?.[1] || !match[2] || match[1].toLowerCase() === "manga") return undefined;
  try {
    return encodePaperbackIdComponent(
      decodePaperbackIdComponent(`${match[1].toLowerCase()}-chapter-${match[2]}`),
    );
  } catch {
    return undefined;
  }
};

export const requestLabel = (url: string): string => requestContext(url);
