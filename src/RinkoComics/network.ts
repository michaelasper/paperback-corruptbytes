import {
  URL as PaperbackURL,
  type Request,
  type Response,
  type SearchQuery,
  type SortingOption,
} from "@paperback/types";

import { responseStatus, SourceHttpError } from "../shared/http.js";
import {
  decodePaperbackIdComponent,
  encodePaperbackIdComponent,
  validateOpaqueId,
} from "../shared/ids.js";
import { isHttpsUrlForHosts } from "../shared/url.js";
import type { RinkoAjaxContext, RinkoSearchMetadata } from "./models.js";

export const DOMAIN = "https://rinkocomics.com";
export const ROOT_URL = `${DOMAIN}/`;
export const CDN_DOMAIN = "https://cdn.rinkocomics.com";
export const REST_BASE_URL = `${DOMAIN}/wp-json/wp/v2`;
export const AJAX_URL = `${DOMAIN}/wp-admin/admin-ajax.php`;
export const FALLBACK_COVER_URL = `${DOMAIN}/wp-content/uploads/2025/10/cropped-RinkoComics.webp`;

export const CATALOG_PAGE_SIZE = 20;
export const TAXONOMY_PAGE_SIZE = 100;
export const MAX_CATALOG_PAGES = 500;
export const MAX_TAXONOMY_PAGES = 100;
export const MAX_CHAPTERS = 2_000;
export const MAX_CHAPTER_BATCHES = 200;
export const MAX_READER_PAGES = 500;
export const MAX_URL_LENGTH = 2_048;
export const MAX_GENRE_FILTERS = 7;
export const MAX_MEDIA_RESPONSE_BYTES = 32 * 1_024 * 1_024;
export const MAX_CONCURRENT_REQUESTS = 16;

const MAX_RAW_SEARCH_LENGTH = 4_096;
const MAX_SEARCH_LENGTH = 256;
const MAX_SLUG_LENGTH = 256;
const MAX_POST_ID_LENGTH = 16;
const SITE_HOSTS = new Set(["rinkocomics.com"]);
const CDN_HOSTS = new Set(["cdn.rinkocomics.com"]);
const MAX_RESPONSE_HEADERS = 256;
const MAX_HEADER_NAME_LENGTH = 256;
const MAX_HEADER_VALUE_LENGTH = 16 * 1_024;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const IMAGE_PATH = /\.(?:avif|bmp|gif|heic|jpe?g|png|tiff?|webp)$/i;
const MIME_TOKEN = "[!#$%&'*+.^_`|~0-9A-Za-z-]+";
const MIME_QUOTED_VALUE =
  '"(?:[\\t\\x20-\\x21\\x23-\\x5B\\x5D-\\x7E\\x80-\\xFF]|\\\\[\\t\\x20-\\x7E\\x80-\\xFF])*"';
const MIME_PARAMETERS = `(?:[ \\t]*;[ \\t]*${MIME_TOKEN}[ \\t]*=[ \\t]*(?:${MIME_TOKEN}|${MIME_QUOTED_VALUE}))*[ \\t]*`;
const IMAGE_CONTENT_TYPE = new RegExp(
  `^image/(?:avif|bmp|gif|heic|heif|jpeg|png|tiff|webp)${MIME_PARAMETERS}$`,
  "i",
);
const MAX_JSON_DEPTH = 128;
export const AJAX_ACCEPT = "application/json, text/javascript, */*; q=0.01";
export const AJAX_CONTENT_TYPE = "application/x-www-form-urlencoded; charset=UTF-8";
const AJAX_REQUEST_HEADER_NAMES = new Set([
  "accept",
  "content-type",
  "origin",
  "referer",
  "x-requested-with",
]);
const arrayBufferByteLengthGetter: unknown = (
  Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength") as
    | { get?: unknown }
    | undefined
)?.get;
const arrayBufferResizableGetter: unknown = (
  Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "resizable") as
    | { get?: unknown }
    | undefined
)?.get;
const IntrinsicUint8Array = Uint8Array;
const VALID_SORTS = new Set(["newest", "oldest", "az", "za"]);
const HTML_CONTENT_TYPE = new RegExp(
  `^(?:text/html|application/xhtml\\+xml)${MIME_PARAMETERS}$`,
  "i",
);
const JSON_CONTENT_TYPE = new RegExp(
  `^application/(?:${MIME_TOKEN}\\+)?json${MIME_PARAMETERS}$`,
  "i",
);
const jsonParseMethod: unknown = (
  Object.getOwnPropertyDescriptor(JSON, "parse") as { value?: unknown } | undefined
)?.value;
const intrinsicDecodeURIComponent = decodeURIComponent;
const intrinsicEncodeURIComponent = encodeURIComponent;

const hasUnsafeTextCodePoint = (value: string): boolean => {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint === undefined ||
      codePoint < 0x20 ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      codePoint === 0x2028 ||
      codePoint === 0x2029 ||
      /\p{Cf}/u.test(character) ||
      (codePoint >= 0xfdd0 && codePoint <= 0xfdef) ||
      (codePoint & 0xffff) >= 0xfffe
    ) {
      return true;
    }
  }
  return false;
};

const hasUnpairedSurrogate = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (index + 1 >= value.length) return true;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
};

export const isValidRinkoHeaderValue = (value: unknown): value is string => {
  if (typeof value !== "string" || value.length > MAX_HEADER_VALUE_LENGTH) return false;
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint === undefined ||
      (codePoint !== 0x09 && codePoint < 0x20) ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      /\p{Cf}/u.test(character) ||
      codePoint > 0xff
    ) {
      return false;
    }
  }
  return true;
};

const fixedArrayBufferByteLength = (value: unknown): number | undefined => {
  try {
    if (typeof arrayBufferByteLengthGetter !== "function") return undefined;
    const byteLength = Reflect.apply(arrayBufferByteLengthGetter, value, []) as number;
    if (!Number.isSafeInteger(byteLength) || byteLength < 0) return undefined;
    if (typeof arrayBufferResizableGetter === "function") {
      const resizable = Reflect.apply(arrayBufferResizableGetter, value, []) as unknown;
      if (resizable !== false) return undefined;
    }
    new IntrinsicUint8Array(value as ArrayBuffer, 0, 0);
    return byteLength;
  } catch {
    return undefined;
  }
};

export const normalizeSearchTerm = (value: unknown): string => {
  if (typeof value !== "string" || value.length > MAX_RAW_SEARCH_LENGTH) {
    throw new Error("Rinko Comics search term is too long.");
  }
  if (hasUnpairedSurrogate(value) || hasUnsafeTextCodePoint(value)) {
    throw new Error("Rinko Comics search term is invalid.");
  }
  const normalized = value
    .trim()
    .replace(/[‘’']/g, " ")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ");
  if (normalized.length > MAX_SEARCH_LENGTH) {
    throw new Error("Rinko Comics search term is too long.");
  }
  return normalized;
};

export const normalizePageNumber = (value: unknown, maximum = MAX_CATALOG_PAGES): number => {
  if (
    !Number.isSafeInteger(maximum) ||
    maximum < 1 ||
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > maximum
  ) {
    throw new Error("Rinko Comics catalog page is invalid.");
  }
  return value;
};

export const isValidRinkoSlug = (value: unknown): value is string => {
  const slug = validateOpaqueId(value, MAX_SLUG_LENGTH);
  return (
    slug !== undefined &&
    !hasUnsafeTextCodePoint(slug) &&
    !hasUnpairedSurrogate(slug) &&
    encodePaperbackIdComponent(slug).length <= MAX_SLUG_LENGTH
  );
};

const positivePostId = (value: unknown, label: string): string => {
  const text = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
  if (
    typeof text !== "string" ||
    text.length > MAX_POST_ID_LENGTH ||
    !/^[1-9]\d*$/.test(text) ||
    !Number.isSafeInteger(Number(text))
  ) {
    throw new Error(`Rinko Comics ${label} is invalid.`);
  }
  return text;
};

const encodeCompositeId = (slug: unknown, postId: unknown, label: string): string => {
  if (!isValidRinkoSlug(slug)) throw new Error(`Rinko Comics ${label} slug is invalid.`);
  return `${encodePaperbackIdComponent(slug)}@${positivePostId(postId, `${label} post ID`)}`;
};

const decodeCompositeId = (value: unknown, label: string): { slug: string; postId: string } => {
  if (typeof value !== "string" || value.length > MAX_SLUG_LENGTH + MAX_POST_ID_LENGTH + 1) {
    throw new Error(`Rinko Comics ${label} is invalid.`);
  }
  const match = value.match(/^(.+)@([1-9]\d*)$/);
  if (!match?.[1] || !match[2]) throw new Error(`Rinko Comics ${label} is invalid.`);
  const slug = decodePaperbackIdComponent(match[1]);
  if (!isValidRinkoSlug(slug) || encodePaperbackIdComponent(slug) !== match[1]) {
    throw new Error(`Rinko Comics ${label} is invalid.`);
  }
  return { slug, postId: positivePostId(match[2], `${label} post ID`) };
};

export const encodeRinkoMangaId = (slug: unknown, postId: unknown): string =>
  encodeCompositeId(slug, postId, "series");

export const decodeRinkoMangaId = (value: unknown): { slug: string; postId: string } =>
  decodeCompositeId(value, "series ID");

export const encodeRinkoChapterId = (slug: unknown, postId: unknown): string =>
  encodeCompositeId(slug, postId, "chapter");

export const decodeRinkoChapterId = (value: unknown): { slug: string; postId: string } =>
  decodeCompositeId(value, "chapter ID");

const parseUrl = (value: string): PaperbackURL | undefined => {
  try {
    return new PaperbackURL(value);
  } catch {
    return undefined;
  }
};

const hasNoFragment = (value: string): boolean => !value.includes("#");

const isSafeUploadPath = (path: string, prefix: string): boolean => {
  if (!path.startsWith(prefix) || path.includes("\\") || path.includes("//")) return false;
  const suffix = path.slice(prefix.length);
  if (!suffix || suffix.startsWith("/") || suffix.endsWith("/")) return false;
  try {
    return suffix.split("/").every((segment) => {
      if (!segment || /%(?:2e|2f|5c)/i.test(segment)) return false;
      const decoded = intrinsicDecodeURIComponent(segment);
      if (
        decoded === "." ||
        decoded === ".." ||
        decoded.includes("/") ||
        decoded.includes("\\") ||
        hasUnsafeTextCodePoint(decoded) ||
        hasUnpairedSurrogate(decoded) ||
        /%[0-9a-f]{2}/i.test(decoded)
      ) {
        return false;
      }
      return intrinsicEncodeURIComponent(decoded) === segment;
    });
  } catch {
    return false;
  }
};

const hasNoQuery = (value: string): boolean => parseUrl(value)?.queryItems === undefined;

export const isRinkoSiteUrl = (value: unknown): value is string =>
  typeof value === "string" &&
  value === value.trim() &&
  value.length <= MAX_URL_LENGTH &&
  !hasUnsafeTextCodePoint(value) &&
  !hasUnpairedSurrogate(value) &&
  isHttpsUrlForHosts(value, SITE_HOSTS) &&
  hasNoFragment(value);

export const isRinkoMediaUrl = (value: unknown): value is string => {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    value.length > MAX_URL_LENGTH ||
    hasUnsafeTextCodePoint(value) ||
    hasUnpairedSurrogate(value) ||
    !value.startsWith(`${CDN_DOMAIN}/`) ||
    !isHttpsUrlForHosts(value, CDN_HOSTS) ||
    !hasNoFragment(value)
  ) {
    return false;
  }
  const parsed = parseUrl(value);
  return Boolean(
    parsed &&
    hasNoQuery(value) &&
    IMAGE_PATH.test(parsed.path) &&
    isSafeUploadPath(parsed.path, "/wp-content/uploads/comics/"),
  );
};

export const isRinkoCoverUrl = (value: unknown): value is string => {
  if (!isRinkoSiteUrl(value) || !value.startsWith(`${DOMAIN}/`) || !hasNoQuery(value)) {
    return false;
  }
  const parsed = parseUrl(value);
  return Boolean(
    parsed && IMAGE_PATH.test(parsed.path) && isSafeUploadPath(parsed.path, "/wp-content/uploads/"),
  );
};

export const isRinkoImageContentType = (value: unknown): value is string =>
  isValidRinkoHeaderValue(value) && IMAGE_CONTENT_TYPE.test(value);

const queryString = (
  entries: readonly (readonly [string, string | number | undefined])[],
): string =>
  entries
    .filter((entry): entry is readonly [string, string | number] => entry[1] !== undefined)
    .map(
      ([name, value]) =>
        `${encodePaperbackIdComponent(name)}=${encodePaperbackIdComponent(String(value))}`,
    )
    .join("&");

const assertUrlLength = (url: string, message: string): string => {
  if (url.length > MAX_URL_LENGTH) throw new Error(message);
  return url;
};

export const buildRestCatalogRequest = (title: unknown, page: unknown): Request => {
  const search = normalizeSearchTerm(title);
  const url = `${REST_BASE_URL}/comic?${queryString([
    ["per_page", CATALOG_PAGE_SIZE],
    ["page", normalizePageNumber(page)],
    ["search", search || undefined],
    ["_embed", "wp:featuredmedia,wp:term"],
  ])}`;
  return {
    url: assertUrlLength(url, "Rinko Comics search term is too long."),
    method: "GET",
  };
};

export const buildGenreRequest = (page: unknown): Request => ({
  url: `${REST_BASE_URL}/comics_genres?${queryString([
    ["per_page", TAXONOMY_PAGE_SIZE],
    ["page", normalizePageNumber(page, MAX_TAXONOMY_PAGES)],
  ])}`,
  method: "GET",
});

export const buildSeriesLookupRequest = (slug: unknown): Request => {
  if (!isValidRinkoSlug(slug)) throw new Error("Rinko Comics series slug is invalid.");
  const url = `${REST_BASE_URL}/comic?${queryString([
    ["slug", slug],
    ["per_page", 1],
    ["_embed", "wp:featuredmedia,wp:term"],
  ])}`;
  return { url: assertUrlLength(url, "Rinko Comics series URL is too long."), method: "GET" };
};

const selectedGenres = (value: unknown): string[] => {
  if (value === undefined) return [];
  const result = new Set<string>();
  try {
    if (!Array.isArray(value)) throw new Error("invalid");
    const length = value.length;
    if (!Number.isSafeInteger(length) || length > MAX_GENRE_FILTERS) throw new Error("invalid");
    let ownEnumerableCount = 0;
    const ownNames = new Set<string>();
    for (const key of Reflect.ownKeys(value)) {
      if (key === "length") {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (
          !descriptor ||
          !("value" in descriptor) ||
          descriptor.value !== length ||
          descriptor.enumerable !== false
        ) {
          throw new Error("invalid");
        }
        continue;
      }
      if (!Object.prototype.propertyIsEnumerable.call(value, key)) throw new Error("invalid");
      const index = typeof key === "string" ? Number(key) : Number.NaN;
      if (
        typeof key !== "string" ||
        !/^(?:0|[1-9]\d*)$/.test(key) ||
        !Number.isSafeInteger(index) ||
        index >= length ||
        ++ownEnumerableCount > length
      ) {
        throw new Error("invalid");
      }
      ownNames.add(key);
    }
    let iteratedCount = 0;
    const entries = value as unknown as Record<string, unknown>;
    for (const key in entries) {
      if (!Object.prototype.hasOwnProperty.call(value, key) || !ownNames.has(key)) {
        throw new Error("invalid");
      }
      iteratedCount += 1;
    }
    if (ownEnumerableCount !== length || iteratedCount !== length) throw new Error("invalid");
    for (let index = 0; index < length; index += 1) {
      const genre = value[index];
      if (!isValidRinkoSlug(genre) || result.has(genre)) throw new Error("invalid");
      result.add(genre);
    }
  } catch {
    throw new Error("Rinko Comics genre filters are invalid.");
  }
  return [...result].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
};

export const normalizeRinkoSearchQuery = (value: unknown): SearchQuery<RinkoSearchMetadata> => {
  let title: unknown;
  let genres: unknown;
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("invalid");
    }
    const ownQueryKeys = new Set<string>();
    for (const key of Reflect.ownKeys(value)) {
      if (
        typeof key !== "string" ||
        !Object.prototype.propertyIsEnumerable.call(value, key) ||
        (key !== "title" && key !== "metadata") ||
        ownQueryKeys.size >= 2
      ) {
        throw new Error("invalid");
      }
      ownQueryKeys.add(key);
    }
    let queryKeys = 0;
    for (const key in value) {
      if (
        !Object.prototype.hasOwnProperty.call(value, key) ||
        !ownQueryKeys.has(key) ||
        ++queryKeys > 2
      ) {
        throw new Error("invalid");
      }
    }
    if (queryKeys !== ownQueryKeys.size) throw new Error("invalid");
    if (!Object.prototype.hasOwnProperty.call(value, "title")) throw new Error("invalid");
    title = (value as Record<string, unknown>)["title"];
    const hasMetadata = Object.prototype.hasOwnProperty.call(value, "metadata");
    const metadata = hasMetadata ? (value as Record<string, unknown>)["metadata"] : undefined;
    if (metadata !== undefined) {
      if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
        throw new Error("invalid");
      }
      const ownMetadataKeys = new Set<string>();
      for (const key of Reflect.ownKeys(metadata)) {
        if (
          typeof key !== "string" ||
          !Object.prototype.propertyIsEnumerable.call(metadata, key) ||
          key !== "genres" ||
          ownMetadataKeys.size >= 1
        ) {
          throw new Error("invalid");
        }
        ownMetadataKeys.add(key);
      }
      let metadataKeys = 0;
      for (const key in metadata) {
        if (
          !Object.prototype.hasOwnProperty.call(metadata, key) ||
          !ownMetadataKeys.has(key) ||
          ++metadataKeys > 1
        ) {
          throw new Error("invalid");
        }
      }
      if (metadataKeys !== ownMetadataKeys.size) throw new Error("invalid");
      genres = Object.prototype.hasOwnProperty.call(metadata, "genres")
        ? (metadata as Record<string, unknown>)["genres"]
        : undefined;
    }
  } catch {
    throw new Error("Rinko Comics search query is invalid.");
  }
  const normalizedTitle = normalizeSearchTerm(title);
  const normalizedGenres = selectedGenres(genres);
  return {
    title: normalizedTitle,
    ...(normalizedGenres.length > 0 && { metadata: { genres: normalizedGenres } }),
  };
};

export const rinkoSortId = (sortingOption: SortingOption | undefined): string => {
  if (sortingOption === undefined) return "newest";
  let id: unknown;
  let label: unknown;
  try {
    if (
      typeof sortingOption !== "object" ||
      sortingOption === null ||
      Array.isArray(sortingOption)
    ) {
      throw new Error("invalid");
    }
    const expected = new Set(["id", "label"]);
    const ownKeys = Reflect.ownKeys(sortingOption);
    if (
      ownKeys.length !== expected.size ||
      ownKeys.some(
        (key) =>
          typeof key !== "string" ||
          !expected.has(key) ||
          !Object.prototype.propertyIsEnumerable.call(sortingOption, key),
      )
    ) {
      throw new Error("invalid");
    }
    let keyCount = 0;
    for (const key in sortingOption) {
      if (
        !Object.prototype.hasOwnProperty.call(sortingOption, key) ||
        !expected.has(key) ||
        ++keyCount > expected.size
      ) {
        throw new Error("invalid");
      }
    }
    if (keyCount !== expected.size) throw new Error("invalid");
    const record = sortingOption as unknown as Record<string, unknown>;
    id = record["id"];
    label = record["label"];
  } catch {
    throw new Error("Rinko Comics sorting option is invalid.");
  }
  if (
    typeof id !== "string" ||
    !VALID_SORTS.has(id) ||
    typeof label !== "string" ||
    label.length < 1 ||
    label.length > 256 ||
    hasUnsafeTextCodePoint(label) ||
    hasUnpairedSurrogate(label)
  ) {
    throw new Error("Rinko Comics sorting option is invalid.");
  }
  return id;
};

export const needsArchiveCatalog = (
  query: SearchQuery<RinkoSearchMetadata>,
  sortingOption: SortingOption | undefined,
): boolean => {
  const normalized = normalizeRinkoSearchQuery(query);
  return Boolean(normalized.metadata?.genres?.length) || rinkoSortId(sortingOption) !== "newest";
};

export const buildArchiveCatalogRequest = (
  query: SearchQuery<RinkoSearchMetadata>,
  sortingOption: SortingOption | undefined,
  page: unknown,
): Request => {
  const currentPage = normalizePageNumber(page);
  const normalizedQuery = normalizeRinkoSearchQuery(query);
  const title = normalizedQuery.title;
  const genres = normalizedQuery.metadata?.genres ?? [];
  const sort = rinkoSortId(sortingOption);
  const path = currentPage === 1 ? "/comic/" : `/comic/page/${currentPage}/`;
  const entries: [string, string | number | undefined][] = [];
  if (title || genres.length > 0) {
    entries.push(["post_type", "comic"]);
    if (title) entries.push(["s", title]);
  }
  for (const genre of genres) entries.push(["genres[]", genre]);
  if (sort !== "newest") entries.push(["sort", sort]);
  const queryPart = queryString(entries);
  const url = `${DOMAIN}${path}${queryPart ? `?${queryPart}` : ""}`;
  return { url: assertUrlLength(url, "Rinko Comics catalog URL is too long."), method: "GET" };
};

export const buildSeriesUrl = (mangaId: unknown): string => {
  const { slug } = decodeRinkoMangaId(mangaId);
  return `${DOMAIN}/comic/${encodePaperbackIdComponent(slug)}/`;
};

export const buildChapterUrl = (chapterId: unknown): string => {
  const { slug } = decodeRinkoChapterId(chapterId);
  return `${DOMAIN}/chapter/${encodePaperbackIdComponent(slug)}/`;
};

export const buildChapterAjaxRequest = (context: RinkoAjaxContext, offset: unknown): Request => {
  let snapshot: RinkoAjaxContext;
  try {
    if (typeof context !== "object" || context === null || Array.isArray(context)) {
      throw new Error("invalid");
    }
    const expected = new Set([
      "ajaxUrl",
      "nonce",
      "comicId",
      "seriesSlug",
      "nextOffset",
      "referer",
    ]);
    const ownKeys = Reflect.ownKeys(context);
    if (
      ownKeys.length !== expected.size ||
      ownKeys.some(
        (key) =>
          typeof key !== "string" ||
          !expected.has(key) ||
          !Object.prototype.propertyIsEnumerable.call(context, key),
      )
    ) {
      throw new Error("invalid");
    }
    let count = 0;
    for (const key in context) {
      if (
        !Object.prototype.hasOwnProperty.call(context, key) ||
        !expected.has(key) ||
        ++count > expected.size
      ) {
        throw new Error("invalid");
      }
    }
    if (count !== expected.size) throw new Error("invalid");
    snapshot = {
      ajaxUrl: context.ajaxUrl,
      nonce: context.nonce,
      comicId: context.comicId,
      seriesSlug: context.seriesSlug,
      nextOffset: context.nextOffset,
      referer: context.referer,
    };
  } catch {
    throw new Error("Rinko Comics chapter request context is invalid.");
  }
  if (!isRinkoSiteUrl(snapshot.referer) || parseUrl(snapshot.referer)?.queryItems) {
    throw new Error("Rinko Comics chapter request context is invalid.");
  }
  const refererSlug = canonicalSeriesSlug(snapshot.referer);
  if (
    !refererSlug ||
    !isValidRinkoSlug(snapshot.seriesSlug) ||
    refererSlug !== snapshot.seriesSlug ||
    snapshot.referer !== `${DOMAIN}/comic/${encodePaperbackIdComponent(refererSlug)}/` ||
    snapshot.ajaxUrl !== AJAX_URL
  ) {
    throw new Error("Rinko Comics chapter request context is invalid.");
  }
  const comicId = positivePostId(snapshot.comicId, "series post ID");
  if (typeof snapshot.nonce !== "string" || !/^[A-Za-z0-9]{1,128}$/.test(snapshot.nonce)) {
    throw new Error("Rinko Comics chapter request nonce is invalid.");
  }
  if (
    typeof snapshot.nextOffset !== "number" ||
    !Number.isSafeInteger(snapshot.nextOffset) ||
    snapshot.nextOffset < 1 ||
    snapshot.nextOffset > MAX_CHAPTERS ||
    snapshot.nextOffset % 10 !== 0 ||
    typeof offset !== "number" ||
    !Number.isSafeInteger(offset) ||
    offset < snapshot.nextOffset ||
    offset > MAX_CHAPTERS ||
    offset % 10 !== 0
  ) {
    throw new Error("Rinko Comics chapter request offset is invalid.");
  }
  return {
    url: AJAX_URL,
    method: "POST",
    headers: {
      accept: AJAX_ACCEPT,
      "content-type": AJAX_CONTENT_TYPE,
      origin: DOMAIN,
      referer: snapshot.referer,
      "x-requested-with": "XMLHttpRequest",
    },
    body: queryString([
      ["action", "load_more_chapters"],
      ["nonce", snapshot.nonce],
      ["comic_id", comicId],
      ["offset", offset],
    ]),
  };
};

export const isValidRinkoAjaxBody = (value: unknown): value is string => {
  if (typeof value !== "string" || value.length > 4_096) return false;
  const match = value.match(
    /^action=load_more_chapters&nonce=([A-Za-z0-9]{1,128})&comic_id=([1-9]\d{0,15})&offset=([1-9]\d*)$/,
  );
  if (!match?.[2] || !match[3]) return false;
  const comicId = Number(match[2]);
  const offset = Number(match[3]);
  return (
    Number.isSafeInteger(comicId) &&
    Number.isSafeInteger(offset) &&
    offset <= MAX_CHAPTERS &&
    offset % 10 === 0
  );
};

const canonicalPathSlug = (
  value: unknown,
  route: "chapter" | "comic",
  acceptedHosts: ReadonlySet<string> = SITE_HOSTS,
): string | undefined => {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    value.length > MAX_URL_LENGTH ||
    hasUnsafeTextCodePoint(value) ||
    hasUnpairedSurrogate(value) ||
    !hasNoFragment(value)
  ) {
    return undefined;
  }
  try {
    const parsed = new PaperbackURL(value);
    const scheme = parsed.protocol.toLowerCase().replace(/:$/, "");
    const host = parsed.hostname.toLowerCase();
    if (
      (scheme !== "http" && scheme !== "https") ||
      !acceptedHosts.has(host.replace(/^www\./, "")) ||
      parsed.username ||
      parsed.password ||
      (parsed.port &&
        !(
          (scheme === "https" && parsed.port === "443") ||
          (scheme === "http" && parsed.port === "80")
        ))
    ) {
      return undefined;
    }
    const match = parsed.path.match(new RegExp(`^/${route}/([^/]+)/?$`));
    if (!match?.[1]) return undefined;
    const slug = intrinsicDecodeURIComponent(match[1]);
    return isValidRinkoSlug(slug) &&
      !/%[0-9a-f]{2}/i.test(slug) &&
      encodePaperbackIdComponent(slug) === match[1]
      ? slug
      : undefined;
  } catch {
    return undefined;
  }
};

export const canonicalSeriesSlug = (value: unknown): string | undefined =>
  canonicalPathSlug(value, "comic");

export const canonicalChapterSlug = (value: unknown): string | undefined =>
  canonicalPathSlug(value, "chapter");

export const parseSeriesUrl = (value: unknown): string | undefined => canonicalSeriesSlug(value);

const queryValue = (
  query: Record<string, string | string[]> | undefined,
  key: string,
): string | string[] | undefined => {
  try {
    return query && Object.prototype.hasOwnProperty.call(query, key) ? query[key] : undefined;
  } catch {
    return undefined;
  }
};

const queryKeys = (query: Record<string, string | string[]> | undefined): string[] | undefined => {
  if (query === undefined) return [];
  const keys: string[] = [];
  try {
    for (const key in query) {
      if (!Object.prototype.hasOwnProperty.call(query, key)) return undefined;
      keys.push(key);
      if (keys.length > 10) return undefined;
    }
  } catch {
    return undefined;
  }
  return keys;
};

const canonicalRestReadUrl = (value: string, parsed: PaperbackURL): boolean => {
  const keys = queryKeys(parsed.queryItems);
  if (!keys) return false;
  if (parsed.path === "/wp-json/wp/v2/comic") {
    const slug = queryValue(parsed.queryItems, "slug");
    if (typeof slug === "string") {
      try {
        return buildSeriesLookupRequest(slug).url === value;
      } catch {
        return false;
      }
    }
    const search = queryValue(parsed.queryItems, "search");
    const page = queryValue(parsed.queryItems, "page");
    if (
      (search !== undefined && typeof search !== "string") ||
      typeof page !== "string" ||
      !/^[1-9]\d*$/.test(page)
    ) {
      return false;
    }
    try {
      return buildRestCatalogRequest(search ?? "", Number(page)).url === value;
    } catch {
      return false;
    }
  }
  if (parsed.path === "/wp-json/wp/v2/comics_genres") {
    const page = queryValue(parsed.queryItems, "page");
    if (typeof page !== "string" || !/^[1-9]\d*$/.test(page)) return false;
    return buildGenreRequest(Number(page)).url === value;
  }
  return false;
};

const canonicalArchiveReadUrl = (value: string, parsed: PaperbackURL): boolean => {
  const match = parsed.path.match(/^\/comic\/(?:page\/([1-9]\d*)\/)?$/);
  const page = match ? Number(match[1] ?? "1") : Number.NaN;
  const keys = queryKeys(parsed.queryItems);
  if (!match || !keys || !Number.isSafeInteger(page) || page > MAX_CATALOG_PAGES) return false;
  const title = queryValue(parsed.queryItems, "s");
  const sort = queryValue(parsed.queryItems, "sort");
  const rawGenres = queryValue(parsed.queryItems, "genres[]");
  if (
    (title !== undefined && typeof title !== "string") ||
    (sort !== undefined && typeof sort !== "string") ||
    (rawGenres !== undefined &&
      typeof rawGenres !== "string" &&
      (!Array.isArray(rawGenres) || rawGenres.some((genre) => typeof genre !== "string")))
  ) {
    return false;
  }
  const genres =
    rawGenres === undefined ? [] : typeof rawGenres === "string" ? [rawGenres] : rawGenres;
  try {
    return (
      buildArchiveCatalogRequest(
        { title: title ?? "", ...(genres.length > 0 && { metadata: { genres } }) },
        sort === undefined ? undefined : { id: sort, label: sort },
        page,
      ).url === value
    );
  } catch {
    return false;
  }
};

/** Restrict first-party reads to the exact routes and canonical queries this source emits. */
export const isRinkoReadUrl = (value: unknown): value is string => {
  if (typeof value !== "string" || !isRinkoSiteUrl(value)) return false;
  if (isRinkoCoverUrl(value) || value === ROOT_URL) return true;
  try {
    const parsed = new PaperbackURL(value);
    if (canonicalRestReadUrl(value, parsed) || canonicalArchiveReadUrl(value, parsed)) return true;
    if (parsed.queryItems !== undefined) return false;
    const seriesSlug = canonicalSeriesSlug(value);
    if (seriesSlug && value === `${DOMAIN}/comic/${encodePaperbackIdComponent(seriesSlug)}/`) {
      return true;
    }
    const chapterSlug = canonicalChapterSlug(value);
    return Boolean(
      chapterSlug && value === `${DOMAIN}/chapter/${encodePaperbackIdComponent(chapterSlug)}/`,
    );
  } catch {
    return false;
  }
};

const sameTrustedReadUrl = (requestUrl: string, responseUrl: string): boolean =>
  isRinkoReadUrl(requestUrl) && isRinkoReadUrl(responseUrl) && requestUrl === responseUrl;

const sameTrustedAjaxUrl = (requestUrl: string, responseUrl: string): boolean =>
  requestUrl === AJAX_URL && responseUrl === AJAX_URL;

const responseUrlPolicy = (method: "GET" | "POST") =>
  method === "GET" ? sameTrustedReadUrl : sameTrustedAjaxUrl;

interface RinkoRawResponse {
  response: Response;
  data: ArrayBuffer;
}

let activeRequestCount = 0;

const scheduledResponseTuple = (value: unknown): [Response, ArrayBuffer] => {
  try {
    if (!Array.isArray(value) || value.length !== 2) throw new Error("invalid");
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== 3 ||
      !keys.includes("0") ||
      !keys.includes("1") ||
      !keys.includes("length")
    ) {
      throw new Error("invalid");
    }
    const first = Object.getOwnPropertyDescriptor(value, "0");
    const second = Object.getOwnPropertyDescriptor(value, "1");
    const length = Object.getOwnPropertyDescriptor(value, "length");
    if (
      !first ||
      !("value" in first) ||
      first.enumerable !== true ||
      !second ||
      !("value" in second) ||
      second.enumerable !== true ||
      !length ||
      !("value" in length) ||
      length.value !== 2 ||
      length.enumerable !== false
    ) {
      throw new Error("invalid");
    }
    const enumerated = new Set<string>();
    const enumerableValue = value as unknown as Record<string, unknown>;
    for (const key in enumerableValue) {
      if (
        !Object.prototype.hasOwnProperty.call(enumerableValue, key) ||
        (key !== "0" && key !== "1") ||
        enumerated.has(key)
      ) {
        throw new Error("invalid");
      }
      enumerated.add(key);
    }
    if (enumerated.size !== 2) throw new Error("invalid");
    return [first.value as Response, second.value as ArrayBuffer];
  } catch {
    throw new Error("Rinko Comics response was invalid.");
  }
};

const scheduleRinkoResponse = async (
  request: Request,
  isResponseUrlAllowed: (requestUrl: string, responseUrl: string) => boolean,
): Promise<RinkoRawResponse> => {
  let requestUrl: string;
  try {
    requestUrl = request.url;
    if (
      typeof requestUrl !== "string" ||
      !requestUrl ||
      isResponseUrlAllowed(requestUrl, requestUrl) !== true
    ) {
      throw new Error("invalid");
    }
  } catch {
    throw new Error("Rinko Comics response URL was not trusted.");
  }
  if (activeRequestCount >= MAX_CONCURRENT_REQUESTS) {
    throw new Error("Rinko Comics request concurrency limit was exceeded.");
  }
  activeRequestCount += 1;
  let scheduled: unknown;
  try {
    scheduled = await Application.scheduleRequest(request);
  } finally {
    activeRequestCount -= 1;
  }
  const [response, data] = scheduledResponseTuple(scheduled);
  if (fixedArrayBufferByteLength(data) === undefined) {
    throw new Error("Rinko Comics response body was invalid.");
  }
  try {
    const responseUrl = response.url;
    if (
      typeof responseUrl !== "string" ||
      !responseUrl ||
      isResponseUrlAllowed(requestUrl, responseUrl) !== true
    ) {
      throw new Error("invalid");
    }
  } catch {
    throw new Error("Rinko Comics response URL was not trusted.");
  }
  return { response, data };
};

/** Snapshot a bounded response-header map and reject malformed or normalized duplicates. */
export const rinkoResponseHeaders = (
  value: unknown,
  expectedNames: readonly string[],
): Readonly<Record<string, string>> => {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("invalid");
    }
    const expected = new Set(expectedNames.map((name) => name.toLowerCase()));
    const seen = new Set<string>();
    const output: Record<string, string> = {};
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length > MAX_RESPONSE_HEADERS) throw new Error("invalid");
    const ownNames = new Set<string>();
    const validateHeader = (name: string): { normalized: string; header: string } => {
      if (name.length < 1 || name.length > MAX_HEADER_NAME_LENGTH || !HEADER_NAME.test(name)) {
        throw new Error("invalid");
      }
      const normalized = name.toLowerCase();
      const header = (value as Record<string, unknown>)[name];
      if (!isValidRinkoHeaderValue(header) || seen.has(normalized)) {
        throw new Error("invalid");
      }
      seen.add(normalized);
      return { normalized, header };
    };
    for (const key of ownKeys) {
      if (typeof key !== "string" || !Object.prototype.propertyIsEnumerable.call(value, key)) {
        throw new Error("invalid");
      }
      ownNames.add(key);
      const { normalized, header } = validateHeader(key);
      if (expected.has(normalized)) output[normalized] = header;
    }
    let inspected = ownKeys.length;
    let hasInherited = false;
    const enumeratedOwnNames = new Set<string>();
    for (const name in value) {
      if (Object.prototype.hasOwnProperty.call(value, name)) {
        if (!ownNames.has(name)) throw new Error("invalid");
        enumeratedOwnNames.add(name);
        continue;
      }
      inspected += 1;
      if (inspected > MAX_RESPONSE_HEADERS) throw new Error("invalid");
      validateHeader(name);
      hasInherited = true;
    }
    if (enumeratedOwnNames.size !== ownNames.size || hasInherited) throw new Error("invalid");
    return output;
  } catch {
    throw new Error("Rinko Comics returned invalid response headers.");
  }
};

const assertContentType = (
  headers: Readonly<Record<string, string>>,
  expected: "HTML" | "JSON",
): void => {
  const value = headers["content-type"];
  const valid =
    value !== undefined &&
    (expected === "HTML" ? HTML_CONTENT_TYPE : JSON_CONTENT_TYPE).test(value);
  if (!valid) throw new Error(`Rinko Comics returned an invalid ${expected} content type.`);
};

const SAFE_TRANSPORT_MESSAGES = new Set([
  "Rinko Comics response URL was not trusted.",
  "Rinko Comics response was invalid.",
  "Rinko Comics response body was invalid.",
  "Rinko Comics response was too large to process safely.",
  "Rinko Comics response limit must be a positive safe integer.",
  "Rinko Comics response body could not be decoded safely.",
  "Rinko Comics returned invalid response headers.",
  "Rinko Comics returned an invalid HTML content type.",
  "Rinko Comics returned an invalid JSON content type.",
]);

const mapTransportError = (error: unknown): never => {
  let sourceStatus: number | undefined;
  try {
    if (error instanceof SourceHttpError) {
      const candidate = error.status;
      if (
        typeof candidate === "number" &&
        Number.isSafeInteger(candidate) &&
        (candidate === -1 || (candidate >= 100 && candidate <= 599))
      ) {
        sourceStatus = candidate;
      }
    }
  } catch {
    sourceStatus = undefined;
  }
  if (sourceStatus !== undefined) {
    if (sourceStatus === 403) {
      throw new Error("Rinko Comics denied this public request. Please try again later.");
    }
    if (sourceStatus === 404) throw new Error("Rinko Comics content was not found.");
    if (sourceStatus === 429) {
      throw new Error("Rinko Comics rate limit reached. Please wait and try again.");
    }
    throw new Error(`Rinko Comics request failed with status ${sourceStatus}.`);
  }
  let message: string | undefined;
  try {
    message = error instanceof Error ? error.message : undefined;
  } catch {
    message = undefined;
  }
  if (message && SAFE_TRANSPORT_MESSAGES.has(message)) throw new Error(message);
  if (message === "Response body could not be decoded safely.") {
    throw new Error("Rinko Comics response body could not be decoded safely.");
  }
  throw new Error("Rinko Comics request could not be completed safely.");
};

const snapshotAjaxHeaders = (value: unknown): Record<string, string> | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const output: Record<string, string> = {};
  const seen = new Set<string>();
  try {
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== AJAX_REQUEST_HEADER_NAMES.size) return undefined;
    const ownNames = new Set<string>();
    for (const key of ownKeys) {
      if (
        typeof key !== "string" ||
        !Object.prototype.propertyIsEnumerable.call(value, key) ||
        key.length < 1 ||
        key.length > MAX_HEADER_NAME_LENGTH ||
        !HEADER_NAME.test(key)
      ) {
        return undefined;
      }
      ownNames.add(key);
    }
    let enumerated = 0;
    for (const name in value) {
      if (!Object.prototype.hasOwnProperty.call(value, name) || !ownNames.has(name)) {
        return undefined;
      }
      enumerated += 1;
      const normalized = name.toLowerCase();
      const header = (value as Record<string, unknown>)[name];
      if (
        !AJAX_REQUEST_HEADER_NAMES.has(normalized) ||
        !isValidRinkoHeaderValue(header) ||
        seen.has(normalized)
      ) {
        return undefined;
      }
      seen.add(normalized);
      output[normalized] = header;
    }
    if (enumerated !== ownNames.size) return undefined;
  } catch {
    return undefined;
  }
  return seen.size === AJAX_REQUEST_HEADER_NAMES.size &&
    output.accept === AJAX_ACCEPT &&
    output["content-type"] === AJAX_CONTENT_TYPE &&
    output.origin === DOMAIN &&
    output["x-requested-with"] === "XMLHttpRequest" &&
    typeof output.referer === "string" &&
    isRinkoReadUrl(output.referer) &&
    canonicalSeriesSlug(output.referer) !== undefined
    ? output
    : undefined;
};

const exactRequestKeys = (value: object, expected: readonly string[]): boolean => {
  try {
    const expectedNames = new Set(expected);
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.length !== expectedNames.size ||
      ownKeys.some(
        (key) =>
          typeof key !== "string" ||
          !expectedNames.has(key) ||
          !Object.prototype.propertyIsEnumerable.call(value, key),
      )
    ) {
      return false;
    }
    let enumerated = 0;
    for (const key in value) {
      if (!Object.prototype.hasOwnProperty.call(value, key) || !expectedNames.has(key))
        return false;
      enumerated += 1;
    }
    return enumerated === expectedNames.size;
  } catch {
    return false;
  }
};

const snapshotFetchRequest = (value: unknown): { request: Request; method: "GET" | "POST" } => {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("invalid");
    }
    const record = value as Partial<Request>;
    if (
      !Object.prototype.hasOwnProperty.call(value, "method") ||
      !Object.prototype.propertyIsEnumerable.call(value, "method")
    ) {
      throw new Error("invalid");
    }
    const rawMethod = record.method;
    const method =
      typeof rawMethod === "string" && /^(?:GET|POST)$/i.test(rawMethod)
        ? (rawMethod.toUpperCase() as "GET" | "POST")
        : undefined;
    const expectedKeys =
      method === "POST" ? ["url", "method", "headers", "body"] : ["url", "method"];
    if (!method || !exactRequestKeys(value, expectedKeys)) throw new Error("invalid");
    const url = record.url;
    if (typeof url !== "string") throw new Error("invalid");
    if (method === "GET") return { request: { url, method }, method };
    const rawHeaders = record.headers;
    const rawBody = record.body;
    const headers = snapshotAjaxHeaders(rawHeaders);
    if (url !== AJAX_URL || !headers || !isValidRinkoAjaxBody(rawBody)) {
      throw new Error("invalid");
    }
    return { request: { url, method, headers, body: rawBody }, method };
  } catch {
    throw new Error("Rinko Comics request is invalid.");
  }
};

const receiveText = async (
  request: Request,
  maxBodyBytes: number,
  expectedContentType: "HTML" | "JSON",
): Promise<{ response: Response; body: string }> => {
  try {
    if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1) {
      throw new Error("Rinko Comics response limit must be a positive safe integer.");
    }
    const snapshot = snapshotFetchRequest(request);
    const requestUrl = snapshot.request.url;
    const result = await scheduleRinkoResponse(
      snapshot.request,
      responseUrlPolicy(snapshot.method),
    );
    const byteLength = fixedArrayBufferByteLength(result.data);
    if (byteLength === undefined) throw new Error("Rinko Comics response body was invalid.");
    if (byteLength > maxBodyBytes) {
      throw new Error("Rinko Comics response was too large to process safely.");
    }
    const status = responseStatus(result.response);
    if (status === undefined || status < 200 || status >= 300) {
      throw new SourceHttpError("Rinko Comics", status);
    }
    let rawHeaders: unknown;
    try {
      rawHeaders = result.response.headers;
    } catch {
      throw new Error("Rinko Comics returned invalid response headers.");
    }
    const headers = rinkoResponseHeaders(rawHeaders, [
      "content-type",
      "x-wp-total",
      "x-wp-totalpages",
    ]);
    assertContentType(headers, expectedContentType);
    if (fixedArrayBufferByteLength(result.data) !== byteLength) {
      throw new Error("Rinko Comics response body was invalid.");
    }
    let body: unknown;
    try {
      body = Application.arrayBufferToUTF8String(result.data);
    } catch {
      throw new Error("Rinko Comics response body could not be decoded safely.");
    }
    if (fixedArrayBufferByteLength(result.data) !== byteLength) {
      throw new Error("Rinko Comics response body was invalid.");
    }
    if (typeof body !== "string" || body.length > maxBodyBytes) {
      throw new Error("Rinko Comics response body could not be decoded safely.");
    }
    return {
      response: {
        url: requestUrl,
        status,
        headers: { ...headers },
        cookies: [],
      },
      body,
    };
  } catch (error: unknown) {
    return mapTransportError(error);
  }
};

export const fetchHtml = async (
  request: Request,
  maxBodyBytes = 2 * 1_024 * 1_024,
): Promise<string> => {
  const result = await receiveText(request, maxBodyBytes, "HTML");
  return result.body;
};

export const parseJsonDocument = <T>(body: string): T => {
  if (typeof body !== "string" || body.length > 2 * 1_024 * 1_024) {
    throw new Error("Rinko Comics returned invalid JSON.");
  }
  if (/^\s*(?:<!doctype\s+html|<html\b)/i.test(body)) {
    throw new Error("Rinko Comics returned HTML instead of JSON.");
  }
  try {
    if (typeof jsonParseMethod !== "function") throw new Error("invalid");
    let index = 0;
    const fail = (): never => {
      throw new Error("invalid");
    };
    const skipWhitespace = (): void => {
      while (
        index < body.length &&
        (body[index] === " " ||
          body[index] === "\t" ||
          body[index] === "\n" ||
          body[index] === "\r")
      ) {
        index += 1;
      }
    };
    const scanString = (): string => {
      if (body[index] !== '"') return fail();
      const start = index;
      index += 1;
      while (index < body.length) {
        const code = body.charCodeAt(index);
        if (code === 0x22) {
          index += 1;
          const value = Reflect.apply(jsonParseMethod, JSON, [body.slice(start, index)]) as unknown;
          if (typeof value !== "string") return fail();
          return value;
        }
        if (code < 0x20) return fail();
        if (code !== 0x5c) {
          index += 1;
          continue;
        }
        index += 1;
        const escape = body[index];
        if (escape === "u") {
          if (!/^[0-9a-fA-F]{4}$/.test(body.slice(index + 1, index + 5))) return fail();
          index += 5;
        } else if (escape && '"\\/bfnrt'.includes(escape)) {
          index += 1;
        } else {
          return fail();
        }
      }
      return fail();
    };
    const scanNumber = (): void => {
      if (body[index] === "-") index += 1;
      if (body[index] === "0") {
        index += 1;
      } else {
        const first = body.charCodeAt(index);
        if (first < 0x31 || first > 0x39) return fail();
        while (body.charCodeAt(index) >= 0x30 && body.charCodeAt(index) <= 0x39) index += 1;
      }
      if (body[index] === ".") {
        index += 1;
        if (body.charCodeAt(index) < 0x30 || body.charCodeAt(index) > 0x39) return fail();
        while (body.charCodeAt(index) >= 0x30 && body.charCodeAt(index) <= 0x39) index += 1;
      }
      if (body[index] === "e" || body[index] === "E") {
        index += 1;
        if (body[index] === "+" || body[index] === "-") index += 1;
        if (body.charCodeAt(index) < 0x30 || body.charCodeAt(index) > 0x39) return fail();
        while (body.charCodeAt(index) >= 0x30 && body.charCodeAt(index) <= 0x39) index += 1;
      }
    };
    const scanValue = (depth: number): void => {
      if (depth > MAX_JSON_DEPTH) return fail();
      skipWhitespace();
      const token = body[index];
      if (token === '"') {
        scanString();
        return;
      }
      if (token === "{") {
        index += 1;
        skipWhitespace();
        const keys = new Set<string>();
        if (body[index] === "}") {
          index += 1;
          return;
        }
        while (index < body.length) {
          const key = scanString();
          if (keys.has(key)) return fail();
          keys.add(key);
          skipWhitespace();
          if (body[index] !== ":") return fail();
          index += 1;
          scanValue(depth + 1);
          skipWhitespace();
          if (body[index] === "}") {
            index += 1;
            return;
          }
          if (body[index] !== ",") return fail();
          index += 1;
          skipWhitespace();
        }
        return fail();
      }
      if (token === "[") {
        index += 1;
        skipWhitespace();
        if (body[index] === "]") {
          index += 1;
          return;
        }
        while (index < body.length) {
          scanValue(depth + 1);
          skipWhitespace();
          if (body[index] === "]") {
            index += 1;
            return;
          }
          if (body[index] !== ",") return fail();
          index += 1;
        }
        return fail();
      }
      for (const literal of ["true", "false", "null"]) {
        if (body.startsWith(literal, index)) {
          index += literal.length;
          return;
        }
      }
      scanNumber();
    };
    scanValue(0);
    skipWhitespace();
    if (index !== body.length) return fail();
    return Reflect.apply(jsonParseMethod, JSON, [body]) as T;
  } catch {
    throw new Error("Rinko Comics returned invalid JSON.");
  }
};

export const fetchJsonResponse = async <T>(
  request: Request,
  maxBodyBytes = 2 * 1_024 * 1_024,
): Promise<{ response: Response; value: T }> => {
  const result = await receiveText(request, maxBodyBytes, "JSON");
  return { response: result.response, value: parseJsonDocument<T>(result.body) };
};
