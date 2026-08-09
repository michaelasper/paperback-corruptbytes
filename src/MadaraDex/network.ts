import type { Request, SearchQuery, SortingOption } from "@paperback/types";

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
  const url = new URL(path, DOMAIN);

  if (search) {
    url.searchParams.set("s", title);
    url.searchParams.set("post_type", "wp-manga");
    for (const genre of selected(metadata?.genres)) url.searchParams.append("genre[]", genre);
    if (metadata?.genreCondition === "and") url.searchParams.set("op", "1");
    const author = normalize(metadata?.author);
    const artist = normalize(metadata?.artist);
    const release = normalize(metadata?.release);
    if (author) url.searchParams.set("author", author);
    if (artist) url.searchParams.set("artist", artist);
    if (release) url.searchParams.set("release", release);
    if (metadata?.adult === "none") url.searchParams.set("adult", "0");
    if (metadata?.adult === "only") url.searchParams.set("adult", "1");
    for (const status of selected(metadata?.status)) url.searchParams.append("status[]", status);
  }

  const sorting = sortingOption?.id || (search ? "relevance" : "latest");
  if (sorting !== "relevance") url.searchParams.set("m_orderby", sorting);
  return url.toString();
};

export const buildMangaUrl = (mangaId: string): string => `${DOMAIN}/?p=${numericId(mangaId)}`;

export const parseMangaUrl = (value: string): string | undefined => {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    if (url.hostname.toLowerCase().replace(/^www\./, "") !== "madaradex.org") return undefined;
    const postId = url.searchParams.get("p")?.trim();
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

const responseBody = (buffer: ArrayBuffer): string => {
  try {
    return Application.arrayBufferToUTF8String(buffer);
  } catch {
    return new TextDecoder().decode(buffer);
  }
};

export const fetchTextResponse = async (request: Request) => {
  const [response, buffer] = await Application.scheduleRequest(request);
  return { response, body: responseBody(buffer) };
};

export const fetchText = async (request: Request): Promise<string> => {
  const { response, body } = await fetchTextResponse(request);
  if (response.status === 404) throw new Error(`MadaraDex content not found: ${request.url}`);
  if (response.status === 429) {
    throw new Error("MadaraDex rate limit reached. Please wait and try again.");
  }
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`MadaraDex request failed with status ${response.status}.`);
  }
  return body;
};
