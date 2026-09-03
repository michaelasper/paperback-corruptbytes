import {
  ContentRating,
  URL as PaperbackURL,
  type ChapterDetails,
  type SourceManga,
} from "@paperback/types";
import { load, type Cheerio, type CheerioAPI } from "cheerio";
import type { AnyNode } from "domhandler";

import { contentRatingForTags, plainTextFromHtml } from "../shared/html.js";
import { encodePaperbackIdComponent } from "../shared/ids.js";
import { resolveHttpsUrl } from "../shared/url.js";
import type {
  RinkoCatalogItem,
  RinkoCatalogPage,
  RinkoChapterRow,
  RinkoGenre,
  RinkoSeriesDocument,
} from "./models.js";
import {
  AJAX_URL,
  CATALOG_PAGE_SIZE,
  DOMAIN,
  FALLBACK_COVER_URL,
  MAX_CATALOG_PAGES,
  MAX_CHAPTERS,
  MAX_READER_PAGES,
  MAX_TAXONOMY_PAGES,
  TAXONOMY_PAGE_SIZE,
  buildChapterUrl,
  buildSeriesUrl,
  canonicalChapterSlug,
  canonicalSeriesSlug,
  decodeRinkoChapterId,
  decodeRinkoMangaId,
  encodeRinkoChapterId,
  encodeRinkoMangaId,
  isRinkoCoverUrl,
  isRinkoMediaUrl,
  isRinkoReadUrl,
  isRinkoSiteUrl,
  isValidRinkoSlug,
  parseJsonDocument,
  rinkoResponseHeaders,
} from "./network.js";

const MAX_TITLE_LENGTH = 2_000;
const MAX_TEXT_LENGTH = 100_000;
const MAX_HTML_LENGTH = 2 * 1_024 * 1_024;
const MAX_ALTERNATE_TITLES = 100;
const MAX_GENRES = 100;
const MAX_AJAX_HTML_LENGTH = 256 * 1_024;
const MAX_NONCE_ASSIGNMENT_LENGTH = 2_048;
const MAX_DECLARED_ITEMS = 1_000_000;
const MAX_CHAPTER_NUMBER = 10_000_000;
const IntrinsicDate = Date;
const dateUtcMethod: unknown = (
  Object.getOwnPropertyDescriptor(Date, "UTC") as { value?: unknown } | undefined
)?.value;
const dateUtc = (year: number, month: number, day: number): number => {
  if (typeof dateUtcMethod !== "function") throw new Error("Date intrinsic is unavailable.");
  return Reflect.apply(dateUtcMethod, IntrinsicDate, [year, month, day]) as number;
};
const dateMethod = (name: string): unknown =>
  (Object.getOwnPropertyDescriptor(Date.prototype, name) as { value?: unknown } | undefined)?.value;
const dateGetTimeMethod = dateMethod("getTime");
const dateGetUtcFullYearMethod = dateMethod("getUTCFullYear");
const dateGetUtcMonthMethod = dateMethod("getUTCMonth");
const dateGetUtcDateMethod = dateMethod("getUTCDate");
const callDateMethod = (method: unknown, value: Date): number => {
  if (typeof method !== "function") throw new Error("Date intrinsic is unavailable.");
  return Reflect.apply(method, value, []) as number;
};
const dateGetTime = (value: Date): number => callDateMethod(dateGetTimeMethod, value);
const dateGetUtcFullYear = (value: Date): number => callDateMethod(dateGetUtcFullYearMethod, value);
const dateGetUtcMonth = (value: Date): number => callDateMethod(dateGetUtcMonthMethod, value);
const dateGetUtcDate = (value: Date): number => callDateMethod(dateGetUtcDateMethod, value);

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord => {
  try {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  } catch {
    return false;
  }
};

const member = (record: JsonRecord, key: string): unknown => {
  try {
    return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
  } catch {
    return undefined;
  }
};

const hasUnsafeCodePoint = (value: string): boolean => {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint === undefined ||
      (codePoint < 0x20 && codePoint !== 0x09 && codePoint !== 0x0a && codePoint !== 0x0d) ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
      /\p{Cf}/u.test(character) ||
      (codePoint >= 0xfdd0 && codePoint <= 0xfdef) ||
      (codePoint & 0xffff) >= 0xfffe
    ) {
      return true;
    }
  }
  return false;
};

const cleanText = (value: unknown, maximum = MAX_TEXT_LENGTH): string | undefined => {
  if (
    typeof value !== "string" ||
    value.length > maximum ||
    !Number.isSafeInteger(maximum) ||
    maximum < 1 ||
    hasUnsafeCodePoint(value)
  ) {
    return undefined;
  }
  const result = value
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return result.length > 0 && result.length <= maximum ? result : undefined;
};

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const loadDocument = (html: string, message: string): CheerioAPI => {
  try {
    return load(html);
  } catch {
    throw new Error(message);
  }
};

const plainText = (html: string, message: string): string => {
  try {
    return plainTextFromHtml(html);
  } catch {
    throw new Error(message);
  }
};

const hasExactEnumerableKeys = (value: JsonRecord, expectedKeys: readonly string[]): boolean => {
  const expected = new Set(expectedKeys);
  try {
    const ownNames = new Set<string>();
    for (const key of Reflect.ownKeys(value)) {
      if (
        typeof key !== "string" ||
        !Object.prototype.propertyIsEnumerable.call(value, key) ||
        !expected.has(key) ||
        ownNames.size >= expected.size
      ) {
        return false;
      }
      ownNames.add(key);
    }
    let count = 0;
    for (const key in value) {
      if (
        !Object.prototype.hasOwnProperty.call(value, key) ||
        !ownNames.has(key) ||
        ++count > expected.size
      ) {
        return false;
      }
    }
    return (
      count === expected.size &&
      ownNames.size === expected.size &&
      expectedKeys.every((key) => Object.prototype.propertyIsEnumerable.call(value, key))
    );
  } catch {
    return false;
  }
};

const positivePostId = (value: unknown): string | undefined => {
  const result = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
  return typeof result === "string" &&
    result.length <= 16 &&
    /^[1-9]\d*$/.test(result) &&
    Number.isSafeInteger(Number(result))
    ? result
    : undefined;
};

const nonNegativeInteger = (value: unknown, maximum: number): number | undefined => {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : undefined;
  }
  if (typeof value !== "string" || value.length > 20 || !/^(?:0|[1-9]\d*)$/.test(value)) {
    return undefined;
  }
  const result = Number(value);
  return Number.isSafeInteger(result) && result <= maximum ? result : undefined;
};

const paginationHeaders = (
  headers: Record<string, string> | undefined,
  maximumItems: number,
  maximumPages: number,
): { totalCount: number | undefined; pageCount: number | undefined } => {
  const values = rinkoResponseHeaders(headers, ["x-wp-total", "x-wp-totalpages"]);
  return {
    totalCount: nonNegativeInteger(values["x-wp-total"], maximumItems),
    pageCount: nonNegativeInteger(values["x-wp-totalpages"], maximumPages),
  };
};

const boundedArray = (value: unknown, maximum: number): unknown[] | undefined => {
  try {
    if (!Number.isSafeInteger(maximum) || maximum < 0 || !Array.isArray(value)) {
      return undefined;
    }
    const length = value.length;
    if (!Number.isSafeInteger(length) || length > maximum) return undefined;
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
          return undefined;
        }
        continue;
      }
      if (!Object.prototype.propertyIsEnumerable.call(value, key)) return undefined;
      const index = typeof key === "string" ? Number(key) : Number.NaN;
      if (
        typeof key !== "string" ||
        !/^(?:0|[1-9]\d*)$/.test(key) ||
        !Number.isSafeInteger(index) ||
        index >= length ||
        ++ownEnumerableCount > length
      ) {
        return undefined;
      }
      ownNames.add(key);
    }
    let iteratedCount = 0;
    const entries = value as unknown as Record<string, unknown>;
    for (const key in entries) {
      if (!Object.prototype.hasOwnProperty.call(value, key) || !ownNames.has(key)) {
        return undefined;
      }
      iteratedCount += 1;
    }
    if (ownEnumerableCount !== length || iteratedCount !== length) return undefined;
    const output: unknown[] = [];
    for (let index = 0; index < length; index += 1) output.push(value[index]);
    return output;
  } catch {
    return undefined;
  }
};

const contentRating = (genres: readonly string[]): ContentRating => {
  const derived = contentRatingForTags(genres);
  return derived === ContentRating.ADULT ? ContentRating.ADULT : ContentRating.MATURE;
};

const canonicalSeriesLink = (value: unknown, expectedSlug: string): string | undefined => {
  const expected = `${DOMAIN}/comic/${encodePaperbackIdComponent(expectedSlug)}/`;
  return typeof value === "string" &&
    value === expected &&
    isRinkoSiteUrl(value) &&
    canonicalSeriesSlug(value) === expectedSlug
    ? value
    : undefined;
};

const canonicalChapterLink = (value: unknown, expectedSlug?: string): string | undefined => {
  if (typeof value !== "string" || !isRinkoSiteUrl(value)) return undefined;
  const slug = canonicalChapterSlug(value);
  if (!slug || (expectedSlug !== undefined && slug !== expectedSlug)) return undefined;
  return value === `${DOMAIN}/chapter/${encodePaperbackIdComponent(slug)}/` ? value : undefined;
};

const embeddedGenres = (record: JsonRecord): string[] => {
  const declared = boundedArray(member(record, "comics_genres"), MAX_GENRES);
  if (!declared) throw new Error("Rinko Comics returned invalid declared genres.");
  const declaredIds = declared.map(positivePostId);
  if (declaredIds.some((id) => id === undefined)) {
    throw new Error("Rinko Comics returned invalid declared genres.");
  }
  const embedded = member(record, "_embedded");
  const groups = isRecord(embedded) ? boundedArray(member(embedded, "wp:term"), 10) : undefined;
  if (!groups) {
    if (declaredIds.length === 0) return [];
    throw new Error("Rinko Comics omitted declared embedded genres.");
  }
  const genres: { id: string; name: string }[] = [];
  for (const group of groups) {
    const terms = boundedArray(group, MAX_GENRES);
    if (!terms) throw new Error("Rinko Comics returned invalid embedded genres.");
    for (const value of terms) {
      if (!isRecord(value) || member(value, "taxonomy") !== "comics_genres") continue;
      const id = positivePostId(member(value, "id"));
      const slug = member(value, "slug");
      const name = cleanText(member(value, "name"), MAX_TITLE_LENGTH);
      if (!id || !isValidRinkoSlug(slug) || !name) {
        throw new Error("Rinko Comics returned an invalid embedded genre.");
      }
      genres.push({ id, name });
      if (genres.length > MAX_GENRES) {
        throw new Error("Rinko Comics returned too many embedded genres.");
      }
    }
  }

  const uniqueDeclared = new Set(declaredIds as string[]);
  const uniqueEmbedded = new Set(genres.map((genre) => genre.id));
  if (
    uniqueDeclared.size !== declaredIds.length ||
    uniqueEmbedded.size !== genres.length ||
    uniqueDeclared.size !== uniqueEmbedded.size ||
    [...uniqueDeclared].some((id) => !uniqueEmbedded.has(id))
  ) {
    throw new Error("Rinko Comics returned inconsistent embedded genres.");
  }
  return genres.map((genre) => genre.name);
};

const embeddedCover = (record: JsonRecord): string => {
  const mediaId = nonNegativeInteger(member(record, "featured_media"), Number.MAX_SAFE_INTEGER);
  if (mediaId === undefined) throw new Error("Rinko Comics returned an invalid cover ID.");
  if (mediaId === 0) return FALLBACK_COVER_URL;

  const embedded = member(record, "_embedded");
  const mediaRows = isRecord(embedded)
    ? boundedArray(member(embedded, "wp:featuredmedia"), 1)
    : undefined;
  const media = mediaRows?.[0];
  if (
    mediaRows?.length !== 1 ||
    !isRecord(media) ||
    nonNegativeInteger(member(media, "id"), Number.MAX_SAFE_INTEGER) !== mediaId ||
    member(media, "media_type") !== "image"
  ) {
    throw new Error("Rinko Comics returned invalid embedded cover metadata.");
  }
  const source = resolveHttpsUrl(member(media, "source_url"), DOMAIN);
  if (!source || !isRinkoCoverUrl(source)) {
    throw new Error("Rinko Comics returned an untrusted cover URL.");
  }
  return source;
};

const catalogItem = (value: unknown): RinkoCatalogItem => {
  if (
    !isRecord(value) ||
    member(value, "status") !== "publish" ||
    member(value, "type") !== "comic"
  ) {
    throw new Error("Rinko Comics returned an invalid catalog entry.");
  }
  const postId = positivePostId(member(value, "id"));
  const slug = member(value, "slug");
  const titleRecord = member(value, "title");
  const renderedTitle = isRecord(titleRecord) ? member(titleRecord, "rendered") : undefined;
  const title =
    typeof renderedTitle === "string" && renderedTitle.length <= MAX_TEXT_LENGTH
      ? cleanText(
          plainText(renderedTitle, "Rinko Comics returned an invalid catalog entry."),
          MAX_TITLE_LENGTH,
        )
      : undefined;
  if (!postId || !isValidRinkoSlug(slug) || !title) {
    throw new Error("Rinko Comics returned an invalid catalog entry.");
  }
  if (!canonicalSeriesLink(member(value, "link"), slug)) {
    throw new Error("Rinko Comics returned a foreign or mismatched series link.");
  }
  const genres = embeddedGenres(value);
  return {
    mangaId: encodeRinkoMangaId(slug, postId),
    slug,
    postId,
    title,
    imageUrl: embeddedCover(value),
    genres,
    contentRating: contentRating(genres),
  };
};

export const parseRestCatalogPage = (
  value: unknown,
  headers: Record<string, string> | undefined,
  expectedPage: number,
): RinkoCatalogPage => {
  const page =
    typeof expectedPage === "number"
      ? nonNegativeInteger(expectedPage, MAX_CATALOG_PAGES)
      : undefined;
  const rows = boundedArray(value, CATALOG_PAGE_SIZE);
  const { totalCount, pageCount } = paginationHeaders(
    headers,
    MAX_DECLARED_ITEMS,
    MAX_CATALOG_PAGES,
  );
  if (!page || !rows || totalCount === undefined || pageCount === undefined) {
    throw new Error("Rinko Comics returned an invalid paginated catalog response.");
  }
  const expectedPageCount = totalCount === 0 ? 0 : Math.ceil(totalCount / CATALOG_PAGE_SIZE);
  if (
    pageCount !== expectedPageCount ||
    (totalCount === 0 ? page !== 1 || rows.length !== 0 : page > pageCount) ||
    (totalCount > 0 &&
      rows.length !==
        (page < pageCount ? CATALOG_PAGE_SIZE : totalCount - CATALOG_PAGE_SIZE * (pageCount - 1)))
  ) {
    throw new Error("Rinko Comics returned inconsistent catalog pagination.");
  }
  const items = rows.map(catalogItem);
  if (
    new Set(items.map((item) => item.mangaId)).size !== items.length ||
    new Set(items.map((item) => item.postId)).size !== items.length ||
    new Set(items.map((item) => item.slug)).size !== items.length
  ) {
    throw new Error("Rinko Comics returned duplicate catalog entries.");
  }
  return {
    items,
    page,
    pageCount,
    totalCount,
    hasNextPage: page < pageCount,
  };
};

export const parseRestSeriesLookup = (
  value: unknown,
  expectedSlug: string,
): RinkoCatalogItem | undefined => {
  if (!isValidRinkoSlug(expectedSlug)) throw new Error("Rinko Comics series slug is invalid.");
  const rows = boundedArray(value, 1);
  if (!rows) throw new Error("Rinko Comics returned an invalid series lookup response.");
  if (rows.length === 0) return undefined;
  const item = catalogItem(rows[0]);
  if (item.slug !== expectedSlug) throw new Error("Rinko Comics returned a different series.");
  return item;
};

const taxonomySlug = (value: unknown): string | undefined => {
  const resolved = resolveHttpsUrl(value, DOMAIN);
  if (typeof value !== "string" || !resolved || value !== resolved || !isRinkoSiteUrl(resolved)) {
    return undefined;
  }
  try {
    const parsed = new PaperbackURL(resolved);
    const match = parsed.path.match(/^\/comics_genres\/([^/]+)\/$/);
    if (!match?.[1] || parsed.queryItems !== undefined) return undefined;
    const slug = decodeURIComponent(match[1]);
    return isValidRinkoSlug(slug) &&
      resolved === `${DOMAIN}/comics_genres/${encodePaperbackIdComponent(slug)}/`
      ? slug
      : undefined;
  } catch {
    return undefined;
  }
};

export const parseGenrePage = (
  value: unknown,
  headers: Record<string, string> | undefined,
  expectedPage: number,
): { genres: RinkoGenre[]; page: number; pageCount: number; totalCount: number } => {
  const page =
    typeof expectedPage === "number"
      ? nonNegativeInteger(expectedPage, MAX_TAXONOMY_PAGES)
      : undefined;
  const rows = boundedArray(value, TAXONOMY_PAGE_SIZE);
  const { totalCount, pageCount } = paginationHeaders(
    headers,
    TAXONOMY_PAGE_SIZE * MAX_TAXONOMY_PAGES,
    MAX_TAXONOMY_PAGES,
  );
  if (!page || !rows || totalCount === undefined || pageCount === undefined) {
    throw new Error("Rinko Comics returned an invalid genre response.");
  }
  const expectedPages = totalCount === 0 ? 0 : Math.ceil(totalCount / TAXONOMY_PAGE_SIZE);
  if (
    pageCount !== expectedPages ||
    (totalCount === 0 ? page !== 1 || rows.length !== 0 : page > pageCount) ||
    (totalCount > 0 &&
      rows.length !==
        (page < pageCount ? TAXONOMY_PAGE_SIZE : totalCount - TAXONOMY_PAGE_SIZE * (pageCount - 1)))
  ) {
    throw new Error("Rinko Comics returned inconsistent genre pagination.");
  }
  const genres = rows.map((entry): RinkoGenre => {
    if (!isRecord(entry) || member(entry, "taxonomy") !== "comics_genres") {
      throw new Error("Rinko Comics returned an invalid genre entry.");
    }
    const postId = positivePostId(member(entry, "id"));
    const slug = member(entry, "slug");
    const title = cleanText(member(entry, "name"), MAX_TITLE_LENGTH);
    const count = nonNegativeInteger(member(entry, "count"), MAX_DECLARED_ITEMS);
    const linkSlug = taxonomySlug(member(entry, "link"));
    if (!postId || !isValidRinkoSlug(slug) || !title || count === undefined || linkSlug !== slug) {
      throw new Error("Rinko Comics returned an invalid genre entry.");
    }
    return { id: slug, postId, title, count };
  });
  if (
    new Set(genres.map((genre) => genre.id)).size !== genres.length ||
    new Set(genres.map((genre) => genre.postId)).size !== genres.length
  ) {
    throw new Error("Rinko Comics returned duplicate genres.");
  }
  return { genres, page, pageCount, totalCount };
};

const genreNamesFromCard = ($: CheerioAPI, card: Cheerio<AnyNode>): string[] => {
  const elements = card.find(".ac-genres a").toArray();
  if (elements.length > MAX_GENRES) {
    throw new Error("Rinko Comics returned invalid catalog genres.");
  }
  const values = elements.map((element) => {
    const title = cleanText($(element).text(), MAX_TITLE_LENGTH);
    const slug = taxonomySlug($(element).attr("href"));
    if (!title || !slug) throw new Error("Rinko Comics returned an invalid catalog genre.");
    return { slug, title };
  });
  if (new Set(values.map((value) => value.slug)).size !== values.length) {
    throw new Error("Rinko Comics returned invalid catalog genres.");
  }
  return values.map((value) => value.title);
};

type QueryBearing = {
  readonly queryItems?: Record<string, string | string[]>;
};

export const sameArchiveQueryItems = (left: QueryBearing, right: QueryBearing): boolean => {
  const normalize = (
    query: Record<string, string | string[]> | undefined,
  ): [string, readonly string[]][] | undefined => {
    const output: [string, readonly string[]][] = [];
    const indexedGenres: string[] = [];
    let hasIndexedGenres = false;
    try {
      if (query === undefined) return [];
      if (typeof query !== "object" || query === null || Array.isArray(query)) return undefined;
      const ownKeys = Reflect.ownKeys(query);
      if (
        ownKeys.length > 10 ||
        ownKeys.some(
          (key) =>
            typeof key !== "string" || !Object.prototype.propertyIsEnumerable.call(query, key),
        )
      ) {
        return undefined;
      }
      let iteratedKeys = 0;
      for (const key in query) {
        if (!Object.prototype.hasOwnProperty.call(query, key)) return undefined;
        iteratedKeys += 1;
      }
      if (iteratedKeys !== ownKeys.length) return undefined;
      for (const key of ownKeys as string[]) {
        const value = query[key];
        const indexedGenre = key.match(/^genres\[(0|[1-9]\d*)\]$/);
        if (indexedGenre) {
          const index = Number(indexedGenre[1]);
          if (
            typeof value !== "string" ||
            !Number.isSafeInteger(index) ||
            index >= MAX_GENRES ||
            Object.prototype.hasOwnProperty.call(indexedGenres, index)
          ) {
            return undefined;
          }
          indexedGenres[index] = value;
          hasIndexedGenres = true;
        } else {
          let values: string[];
          if (typeof value === "string") {
            values = [value];
          } else {
            const snapshot = boundedArray(value, MAX_GENRES);
            if (!snapshot || snapshot.some((entry) => typeof entry !== "string")) {
              return undefined;
            }
            values = snapshot as string[];
          }
          output.push([key, values]);
        }
        if (output.length + indexedGenres.length > 10) return undefined;
      }
      if (hasIndexedGenres) {
        if (output.some(([key]) => key === "genres[]") || indexedGenres.length === 0) {
          return undefined;
        }
        for (let index = 0; index < indexedGenres.length; index += 1) {
          if (!Object.prototype.hasOwnProperty.call(indexedGenres, index)) return undefined;
        }
        output.push(["genres[]", indexedGenres]);
      }
    } catch {
      return undefined;
    }
    return output.sort(([leftKey], [rightKey]) => compareText(leftKey, rightKey));
  };
  let leftItems: [string, readonly string[]][] | undefined;
  let rightItems: [string, readonly string[]][] | undefined;
  try {
    if (
      typeof left !== "object" ||
      left === null ||
      typeof right !== "object" ||
      right === null ||
      !Object.prototype.hasOwnProperty.call(left, "queryItems") ||
      !Object.prototype.hasOwnProperty.call(right, "queryItems")
    ) {
      return false;
    }
    leftItems = normalize(left.queryItems);
    rightItems = normalize(right.queryItems);
  } catch {
    return false;
  }
  if (!leftItems || !rightItems || leftItems.length !== rightItems.length) return false;
  return leftItems.every(([key, values], index) => {
    const expected = rightItems[index];
    return Boolean(
      expected &&
      key === expected[0] &&
      values.length === expected[1].length &&
      values.every((value, valueIndex) => value === expected[1][valueIndex]),
    );
  });
};

export const parseArchiveCatalogPage = (
  html: string,
  expectedPage: number,
  expectedNextUrl: string | undefined,
): RinkoCatalogPage => {
  if (typeof html !== "string" || html.length > MAX_HTML_LENGTH) {
    throw new Error("Rinko Comics returned invalid catalog HTML.");
  }
  const page =
    typeof expectedPage === "number"
      ? nonNegativeInteger(expectedPage, MAX_CATALOG_PAGES)
      : undefined;
  if (
    !page ||
    (page < MAX_CATALOG_PAGES &&
      (!isRinkoReadUrl(expectedNextUrl) ||
        new PaperbackURL(expectedNextUrl).path !== `/comic/page/${page + 1}/`)) ||
    (page === MAX_CATALOG_PAGES && expectedNextUrl !== undefined)
  ) {
    throw new Error("Rinko Comics catalog page is invalid.");
  }
  const $ = loadDocument(html, "Rinko Comics returned invalid catalog HTML.");
  const elements = $(".ac-grid > article.ac-card[data-id]").toArray();
  if (elements.length > CATALOG_PAGE_SIZE) {
    throw new Error("Rinko Comics returned too many catalog cards.");
  }
  const items = elements.map((element): RinkoCatalogItem => {
    const card = $(element);
    const postId = positivePostId(card.attr("data-id"));
    const titleLinks = card.find(".ac-title a[href]").toArray();
    const thumbLinks = card.find("a.ac-thumb[href]").toArray();
    const images = card.find("a.ac-thumb[href] img").toArray();
    const titleLink = $(titleLinks[0]!);
    const thumbLink = $(thumbLinks[0]!);
    const slug = canonicalSeriesSlug(titleLink.attr("href"));
    if (
      titleLinks.length !== 1 ||
      thumbLinks.length !== 1 ||
      images.length !== 1 ||
      !postId ||
      !slug ||
      !isRinkoSiteUrl(titleLink.attr("href")) ||
      canonicalSeriesLink(titleLink.attr("href"), slug) === undefined ||
      canonicalSeriesLink(thumbLink.attr("href"), slug) === undefined
    ) {
      throw new Error("Rinko Comics returned an invalid catalog card link.");
    }
    const title = cleanText(titleLink.text(), MAX_TITLE_LENGTH);
    const imageUrl = resolveHttpsUrl($(images[0]!).attr("src"), DOMAIN);
    if (!title || !imageUrl || !isRinkoCoverUrl(imageUrl)) {
      throw new Error("Rinko Comics returned an invalid catalog card.");
    }
    const genres = genreNamesFromCard($, card);
    return {
      mangaId: encodeRinkoMangaId(slug, postId),
      slug,
      postId,
      title,
      imageUrl,
      genres,
      contentRating: contentRating(genres),
    };
  });
  if (
    new Set(items.map((item) => item.mangaId)).size !== items.length ||
    new Set(items.map((item) => item.postId)).size !== items.length ||
    new Set(items.map((item) => item.slug)).size !== items.length
  ) {
    throw new Error("Rinko Comics returned duplicate catalog cards.");
  }

  const paginationElements = $(".ac-pagination").toArray();
  if (paginationElements.length > 1) {
    throw new Error("Rinko Comics returned invalid catalog pagination.");
  }
  const pagination = $(paginationElements[0]!);
  const currentElements = pagination.find(".page-numbers.current").toArray();
  if (pagination.length > 0) {
    const current = cleanText($(currentElements[0]!).text(), 16);
    if (
      currentElements.length > 1 ||
      (current !== undefined && current !== String(page)) ||
      (current === undefined && (page !== 1 || pagination.children().length !== 0))
    ) {
      throw new Error("Rinko Comics returned the wrong catalog page.");
    }
  } else if (page !== 1) {
    throw new Error("Rinko Comics returned the wrong catalog page.");
  }
  const nextElements = pagination.find("a.next.page-numbers[href]").toArray();
  if (nextElements.length > 1) {
    throw new Error("Rinko Comics returned invalid catalog pagination.");
  }
  const nextHref = $(nextElements[0]!).attr("href");
  let hasNextPage = false;
  if (nextHref !== undefined) {
    const resolved = resolveHttpsUrl(nextHref, DOMAIN);
    if (!resolved || nextHref !== resolved || !isRinkoSiteUrl(resolved)) {
      throw new Error("Rinko Comics returned an invalid next-page link.");
    }
    if (expectedNextUrl === undefined) {
      throw new Error("Rinko Comics returned an inconsistent next-page link.");
    }
    const actual = new PaperbackURL(resolved);
    const expected = new PaperbackURL(expectedNextUrl);
    if (actual.path !== expected.path || !sameArchiveQueryItems(actual, expected)) {
      throw new Error("Rinko Comics returned an inconsistent next-page link.");
    }
    hasNextPage = true;
  }
  if (hasNextPage && items.length !== CATALOG_PAGE_SIZE) {
    throw new Error("Rinko Comics returned a truncated catalog page.");
  }
  return { items, page, hasNextPage };
};

const MONTHS = new Map<string, number>([
  ["jan", 0],
  ["january", 0],
  ["feb", 1],
  ["february", 1],
  ["mar", 2],
  ["march", 2],
  ["apr", 3],
  ["april", 3],
  ["may", 4],
  ["jun", 5],
  ["june", 5],
  ["jul", 6],
  ["july", 6],
  ["aug", 7],
  ["august", 7],
  ["sep", 8],
  ["sept", 8],
  ["september", 8],
  ["oct", 9],
  ["october", 9],
  ["nov", 10],
  ["november", 10],
  ["dec", 11],
  ["december", 11],
]);

export const parseRinkoDate = (value: unknown): Date | undefined => {
  const text = cleanText(value, 64);
  const match = text?.match(/^([A-Za-z]{3,9})\s+(\d{1,2}),\s+(\d{4})$/);
  if (!match?.[1] || !match[2] || !match[3]) return undefined;
  const month = MONTHS.get(match[1].toLowerCase());
  const day = Number(match[2]);
  const year = Number(match[3]);
  if (month === undefined || year < 1970 || year > 9999 || day < 1 || day > 31) return undefined;
  try {
    const timestamp = dateUtc(year, month, day);
    const date = new IntrinsicDate(timestamp);
    if (
      dateGetUtcFullYear(date) !== year ||
      dateGetUtcMonth(date) !== month ||
      dateGetUtcDate(date) !== day
    ) {
      return undefined;
    }
    return date;
  } catch {
    return undefined;
  }
};

const chapterRows = (
  $: CheerioAPI,
  elements: AnyNode[],
  sourceTitle: string,
): RinkoChapterRow[] => {
  if (!cleanText(sourceTitle, MAX_TITLE_LENGTH)) {
    throw new Error("Rinko Comics chapter source title is invalid.");
  }
  if (elements.length > 10) throw new Error("Rinko Comics returned too many chapter rows.");
  const rows = elements.map((element): RinkoChapterRow => {
    const row = $(element);
    const numberElements = row.find(".chapter-number").toArray();
    const dateElements = row.find(".chapter-date").toArray();
    const anchorElements = row.find("a[href]").toArray();
    const postId = positivePostId(row.attr("data-post-id"));
    const reason = row.attr("data-reason");
    const price = nonNegativeInteger(row.attr("data-price"), 1_000_000);
    const dataTitleAttribute = row.attr("data-title");
    const rawDataTitle = cleanText(dataTitleAttribute, MAX_TITLE_LENGTH);
    const label = cleanText($(numberElements[0]!).text(), MAX_TITLE_LENGTH);
    const match = label?.match(/^Chapter\s+((?:0|[1-9]\d*)(?:\.\d+)?)(?:\s*[-:–—]\s*(.+))?$/i);
    const chapNum = match?.[1] ? Number(match[1]) : Number.NaN;
    if (
      numberElements.length !== 1 ||
      dateElements.length !== 1 ||
      anchorElements.length !== 1 ||
      !postId ||
      typeof reason !== "string" ||
      !/^[a-z][a-z0-9_]{0,63}$/.test(reason) ||
      price === undefined ||
      !rawDataTitle ||
      dataTitleAttribute !== rawDataTitle ||
      !label ||
      !Number.isFinite(chapNum) ||
      chapNum < 0 ||
      chapNum > MAX_CHAPTER_NUMBER
    ) {
      throw new Error("Rinko Comics returned an invalid chapter row.");
    }
    const isPublic = reason === "free" && !row.hasClass("is-locked");
    let slug: string | undefined;
    let url: string | undefined;
    let chapterId: string | undefined;
    if (isPublic) {
      url = canonicalChapterLink($(anchorElements[0]!).attr("href"));
      const permalink = canonicalChapterLink(row.attr("data-permalink"));
      slug = url ? canonicalChapterSlug(url) : undefined;
      if (!url || permalink !== url || !slug) {
        throw new Error("Rinko Comics returned an invalid public chapter link.");
      }
      chapterId = encodeRinkoChapterId(slug, postId);
    }
    const publishDateText = $(dateElements[0]!).text();
    const publishDate = publishDateText.trim() ? parseRinkoDate(publishDateText) : undefined;
    if (publishDateText.trim() && !publishDate) {
      throw new Error("Rinko Comics returned an invalid chapter date.");
    }
    const title = cleanText(match?.[2], MAX_TITLE_LENGTH);
    return {
      ...(chapterId && { chapterId }),
      postId,
      ...(slug && { slug }),
      ...(url && { url }),
      chapNum,
      siteTitle: rawDataTitle,
      ...(title && { title }),
      ...(publishDate && { publishDate }),
      isPublic,
    };
  });
  if (new Set(rows.map((row) => row.postId)).size !== rows.length) {
    throw new Error("Rinko Comics returned duplicate chapter post IDs.");
  }
  const publicIds = rows.flatMap((row) => (row.chapterId ? [row.chapterId] : []));
  const publicSlugs = rows.flatMap((row) => (row.slug ? [row.slug] : []));
  const publicUrls = rows.flatMap((row) => (row.url ? [row.url] : []));
  if (
    new Set(publicIds).size !== publicIds.length ||
    new Set(publicSlugs).size !== publicSlugs.length ||
    new Set(publicUrls).size !== publicUrls.length
  ) {
    throw new Error("Rinko Comics returned duplicate public chapter routes.");
  }
  return rows;
};

const parseNonce = (html: string): { ajaxUrl: string; nonce: string } => {
  const expression = /var\s+comicworld_ajax\s*=\s*(\{[^;\r\n]{1,2048}\})\s*;/g;
  let assignment: string | undefined;
  let matchCount = 0;
  for (const match of html.matchAll(expression)) {
    matchCount += 1;
    assignment = match[1];
    if (matchCount > 1) break;
  }
  if (matchCount !== 1 || !assignment || assignment.length > MAX_NONCE_ASSIGNMENT_LENGTH) {
    throw new Error("Rinko Comics returned an invalid chapter nonce assignment.");
  }
  let value: unknown;
  try {
    value = parseJsonDocument(assignment);
  } catch {
    throw new Error("Rinko Comics returned an invalid chapter nonce assignment.");
  }
  if (!isRecord(value)) throw new Error("Rinko Comics returned an invalid chapter nonce.");
  let keyCount = 0;
  try {
    for (const key in value) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) {
        throw new Error("invalid");
      }
      keyCount += 1;
      if ((key !== "ajax_url" && key !== "nonce") || keyCount > 2) {
        throw new Error("invalid");
      }
    }
  } catch {
    throw new Error("Rinko Comics returned an invalid chapter nonce.");
  }
  const ajaxUrl = member(value, "ajax_url");
  const nonce = member(value, "nonce");
  if (
    keyCount !== 2 ||
    ajaxUrl !== AJAX_URL ||
    typeof nonce !== "string" ||
    !/^[A-Za-z0-9]{1,128}$/.test(nonce)
  ) {
    throw new Error("Rinko Comics returned an invalid chapter nonce.");
  }
  return { ajaxUrl, nonce };
};

const splitAlternateTitles = (values: string[], primaryTitle: string): string[] => {
  const seen = new Set([primaryTitle.toLowerCase()]);
  const output: string[] = [];
  for (const value of values) {
    if (typeof value !== "string" || value.length > MAX_TITLE_LENGTH * 2) {
      throw new Error("Rinko Comics returned an invalid alternate title.");
    }
    const candidates = value.split(/\s+\/\s+/);
    if (candidates.length > MAX_ALTERNATE_TITLES) {
      throw new Error("Rinko Comics returned too many alternate titles.");
    }
    for (const candidate of candidates) {
      const title = cleanText(candidate, MAX_TITLE_LENGTH);
      const key = title?.toLowerCase();
      if (!title || !key || seen.has(key)) continue;
      seen.add(key);
      output.push(title);
      if (output.length > MAX_ALTERNATE_TITLES) {
        throw new Error("Rinko Comics returned too many alternate titles.");
      }
    }
  }
  return output;
};

const statusValue = (value: string | undefined): string | undefined => {
  switch (value) {
    case "ongoing":
      return "Ongoing";
    case "completed":
      return "Completed";
    case "hiatus":
      return "Hiatus";
    case "dropped":
      return "Dropped";
    case "cancelled":
      return "Cancelled";
    default:
      return undefined;
  }
};

export const parseSeriesDocument = (html: string, mangaId: string): RinkoSeriesDocument => {
  if (typeof html !== "string" || html.length > MAX_HTML_LENGTH) {
    throw new Error("Rinko Comics returned invalid series HTML.");
  }
  const identity = decodeRinkoMangaId(mangaId);
  const expectedUrl = buildSeriesUrl(mangaId);
  const $ = loadDocument(html, "Rinko Comics returned invalid series HTML.");
  const canonicalLinks = $("link[rel='canonical'][href]").toArray();
  if (
    canonicalLinks.length < 1 ||
    canonicalLinks.length > 4 ||
    canonicalLinks.some(
      (element) => canonicalSeriesLink($(element).attr("href"), identity.slug) !== expectedUrl,
    )
  ) {
    throw new Error("Rinko Comics returned details for a different series.");
  }
  const titleElements = $(".comic-info-upper h1").toArray();
  const title = cleanText($(titleElements[0]!).text(), MAX_TITLE_LENGTH);
  if (titleElements.length !== 1 || !title) {
    throw new Error("Rinko Comics returned an invalid series title.");
  }

  const coverElements = $(".comic-cover img.comic-cover__image").toArray();
  const cover = $(coverElements[0]!);
  const coverValue = resolveHttpsUrl(cover.attr("data-src") ?? cover.attr("src"), DOMAIN);
  if (coverElements.length !== 1 || !coverValue || !isRinkoCoverUrl(coverValue)) {
    throw new Error("Rinko Comics returned an invalid series cover.");
  }

  const graphElements = $(".comic-graph > span").toArray();
  const graph = graphElements.map((element) => cleanText($(element).text(), MAX_TITLE_LENGTH));
  if (
    graph.length !== 5 ||
    !graph[0] ||
    graph[1] !== "•" ||
    !graph[2] ||
    graph[3] !== "•" ||
    !graph[4]
  ) {
    throw new Error("Rinko Comics returned invalid series metadata.");
  }
  const [author, , format, , views] = graph;

  const statistics = new Map<string, string>();
  const statisticRows = $(".statistics > div").toArray();
  const statisticLabels = new Set(["status", "chapters", "updated"]);
  if (statisticRows.length < 2 || statisticRows.length > statisticLabels.size) {
    throw new Error("Rinko Comics returned invalid series metadata.");
  }
  for (const row of statisticRows) {
    const spans = $(row).find("> div > span").toArray();
    const label = cleanText(spans[0] ? $(spans[0]).text() : undefined, 64)?.toLowerCase();
    const value = cleanText(spans[1] ? $(spans[1]).text() : undefined, MAX_TITLE_LENGTH);
    if (spans.length !== 2 || !label || !statisticLabels.has(label) || !value) {
      throw new Error("Rinko Comics returned invalid series metadata.");
    }
    if (statistics.has(label)) throw new Error("Rinko Comics returned duplicate series metadata.");
    statistics.set(label, value);
  }
  const chapterCount = nonNegativeInteger(statistics.get("chapters"), MAX_CHAPTERS);
  if (chapterCount === undefined) {
    throw new Error("Rinko Comics returned an invalid declared chapter count.");
  }

  const genreElements = $(".comic-genres .genres .genre").toArray();
  if (genreElements.length > MAX_GENRES) throw new Error("Rinko Comics returned too many genres.");
  const genres = genreElements.map((element) => {
    const value = cleanText($(element).text(), MAX_TITLE_LENGTH);
    if (!value) throw new Error("Rinko Comics returned an invalid genre.");
    return value;
  });
  if (new Set(genres.map((genre) => genre.toLowerCase())).size !== genres.length) {
    throw new Error("Rinko Comics returned duplicate genres.");
  }

  const alternateElements = $(".alt-titles-list .alt-title").toArray();
  if (alternateElements.length > MAX_ALTERNATE_TITLES) {
    throw new Error("Rinko Comics returned too many alternate titles.");
  }
  const secondaryTitles = splitAlternateTitles(
    alternateElements.map((element) => $(element).text()),
    title,
  );
  const synopsisElements = $(".comic-synopsis").toArray();
  const synopsisHtml = $(synopsisElements[0]!).html() ?? "";
  if (synopsisElements.length !== 1 || synopsisHtml.length > MAX_TEXT_LENGTH) {
    throw new Error("Rinko Comics synopsis is invalid or too large.");
  }
  const synopsis =
    cleanText(
      plainText(synopsisHtml, "Rinko Comics synopsis is invalid or too large."),
      MAX_TEXT_LENGTH,
    ) ?? "";

  const chapterSections = $(".comic-page-chapters").toArray();
  const chapterSection = $(chapterSections[0]!);
  const headingContainer = chapterSection.children().first();
  const headingChildren = headingContainer.children().toArray();
  const headingElements = headingContainer.children("div").toArray();
  const reverseButtons = headingContainer.children("button.reverse-order-btn").toArray();
  const chapterHeading = cleanText($(headingElements[0]!).text(), 256);
  const headingCount = nonNegativeInteger(
    chapterHeading?.match(/^Chapters \((\d+)\)$/)?.[1],
    MAX_CHAPTERS,
  );
  if (
    chapterSections.length !== 1 ||
    !headingContainer.is("div") ||
    headingChildren.length !== 2 ||
    headingElements.length !== 1 ||
    reverseButtons.length !== 1 ||
    cleanText($(reverseButtons[0]!).text(), MAX_TITLE_LENGTH) !== "Newest First" ||
    headingCount !== chapterCount
  ) {
    throw new Error("Rinko Comics returned inconsistent declared chapter totals.");
  }

  const chapterLists = chapterSection.children("ul.chapters-list").toArray();
  const list = $(chapterLists[0]!);
  const listChildren = list.children().toArray();
  const initialElements = list.children("li.chapter").toArray();
  const expectedInitial = Math.min(10, chapterCount);
  if (
    chapterLists.length !== 1 ||
    listChildren.length !== initialElements.length ||
    initialElements.length !== expectedInitial
  ) {
    throw new Error("Rinko Comics returned an inconsistent initial chapter list.");
  }
  const initialRows = chapterRows($, initialElements, title);

  const sectionChildren = chapterSection.children().toArray();
  const loadMoreContainers = chapterSection.children("div.load-more-container").toArray();
  const buttons = chapterSection.find("#loadMoreChaptersBtn").toArray();
  const button = $(buttons[0]!);
  const comicId = positivePostId(button.attr("data-comic-id"));
  const nextOffset = nonNegativeInteger(button.attr("data-offset"), MAX_CHAPTERS);
  if (
    sectionChildren.length !== 3 ||
    sectionChildren[0] !== headingContainer[0] ||
    sectionChildren[1] !== chapterLists[0] ||
    sectionChildren[2] !== loadMoreContainers[0] ||
    loadMoreContainers.length !== 1 ||
    buttons.length !== 1 ||
    !button.is("button.load-more-btn") ||
    !button.parent().is(loadMoreContainers[0]!) ||
    comicId !== identity.postId ||
    nextOffset !== 10
  ) {
    throw new Error("Rinko Comics returned an invalid chapter pagination control.");
  }

  let ajaxContext: RinkoSeriesDocument["ajaxContext"];
  if (chapterCount > initialRows.length) {
    const nonce = parseNonce(html);
    ajaxContext = {
      ajaxUrl: nonce.ajaxUrl,
      nonce: nonce.nonce,
      comicId,
      seriesSlug: identity.slug,
      nextOffset,
      referer: expectedUrl,
    };
  }

  const status = statusValue(statistics.get("status"));
  if (!status) throw new Error("Rinko Comics returned an invalid series status.");
  const updated = statistics.get("updated");
  if (updated !== undefined && !parseRinkoDate(updated)) {
    throw new Error("Rinko Comics returned an invalid series update date.");
  }
  const additionalInfo: Record<string, string> = {
    slug: identity.slug,
    postId: identity.postId,
    chapterCount: String(chapterCount),
    ...(format && { type: format }),
    ...(views && { views }),
    ...(updated && { updated }),
  };
  const manga: SourceManga = {
    mangaId,
    mangaInfo: {
      primaryTitle: title,
      secondaryTitles,
      thumbnailUrl: coverValue,
      synopsis,
      contentRating: contentRating(genres),
      contentType: "comic",
      ...(author && { author }),
      ...(status && { status }),
      ...(genres.length > 0 && {
        tagGroups: [
          {
            id: "genres",
            title: "Genres",
            tags: genres.map((genre) => ({ id: genre, title: genre })),
          },
        ],
      }),
      additionalInfo,
      shareUrl: expectedUrl,
    },
  };
  return { manga, chapterCount, initialRows, ...(ajaxContext && { ajaxContext }) };
};

export const parseAjaxChapterRows = (value: unknown, sourceTitle: string): RinkoChapterRow[] => {
  if (
    !isRecord(value) ||
    !hasExactEnumerableKeys(value, ["success", "data"]) ||
    member(value, "success") !== true
  ) {
    throw new Error("Rinko Comics returned an invalid chapter pagination response.");
  }
  const data = member(value, "data");
  if (!isRecord(data) || !hasExactEnumerableKeys(data, ["html"])) {
    throw new Error("Rinko Comics returned an invalid chapter pagination response.");
  }
  const html = member(data, "html");
  if (typeof html !== "string" || html.length > MAX_AJAX_HTML_LENGTH) {
    throw new Error("Rinko Comics returned invalid chapter pagination HTML.");
  }
  if (!html.trim()) return [];
  const $ = loadDocument(
    `<ul id="rinko-rows">${html}</ul>`,
    "Rinko Comics returned invalid chapter pagination HTML.",
  );
  const roots = $("#rinko-rows").toArray();
  const rootNode = roots[0]!;
  const root = $(rootNode);
  const hasUnexpectedOuterContent =
    $("head").contents().length !== 0 ||
    $("body")
      .contents()
      .toArray()
      .some((node) =>
        node.type === "text" ? $(node).text().trim().length > 0 : node !== rootNode,
      );
  const elementChildren = root.children().toArray();
  const elements = root.children("li.chapter").toArray();
  const expectedElements = new Set<AnyNode>(elements);
  const hasUnexpectedContent = root
    .contents()
    .toArray()
    .some((node) =>
      node.type === "text" ? $(node).text().trim().length > 0 : !expectedElements.has(node),
    );
  if (
    roots.length !== 1 ||
    $("body").children().length !== 1 ||
    hasUnexpectedOuterContent ||
    elements.length === 0 ||
    elementChildren.length !== elements.length ||
    hasUnexpectedContent
  ) {
    throw new Error("Rinko Comics returned invalid chapter pagination HTML.");
  }
  return chapterRows($, elements, sourceTitle);
};

const readerPostId = ($: CheerioAPI): string | undefined => {
  const links = $("link[rel='alternate'][type='application/json'][href]").toArray();
  if (links.length !== 1) return undefined;
  const rawHref = $(links[0]!).attr("href");
  const href = resolveHttpsUrl(rawHref, DOMAIN);
  if (typeof rawHref !== "string" || !href || rawHref !== href || !isRinkoSiteUrl(href)) {
    return undefined;
  }
  try {
    const parsed = new PaperbackURL(href);
    const match = parsed.path.match(/^\/wp-json\/wp\/v2\/chapters\/([1-9]\d*)$/);
    const id = positivePostId(match?.[1]);
    return id && parsed.queryItems === undefined ? id : undefined;
  } catch {
    return undefined;
  }
};

export const parseChapterDetails = (
  html: string,
  chapterId: string,
  mangaId: string,
  expectedChapNum: number,
  expectedSiteTitle: string,
): ChapterDetails => {
  if (typeof html !== "string" || html.length > MAX_HTML_LENGTH) {
    throw new Error("Rinko Comics returned invalid reader HTML.");
  }
  if (
    typeof expectedChapNum !== "number" ||
    !Number.isFinite(expectedChapNum) ||
    expectedChapNum < 0 ||
    Object.is(expectedChapNum, -0) ||
    expectedChapNum > MAX_CHAPTER_NUMBER ||
    !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(String(expectedChapNum))
  ) {
    throw new Error("Rinko Comics returned content for a different chapter number.");
  }
  const trustedSiteTitle = cleanText(expectedSiteTitle, MAX_TITLE_LENGTH);
  if (trustedSiteTitle === undefined || expectedSiteTitle !== trustedSiteTitle) {
    throw new Error("Rinko Comics returned content for a different chapter title.");
  }
  const identity = decodeRinkoChapterId(chapterId);
  decodeRinkoMangaId(mangaId);
  const expectedUrl = buildChapterUrl(chapterId);
  const $ = loadDocument(html, "Rinko Comics returned invalid reader HTML.");
  const canonicalLinks = $("link[rel='canonical'][href]").toArray();
  if (
    canonicalLinks.length < 1 ||
    canonicalLinks.length > 4 ||
    canonicalLinks.some(
      (element) => canonicalChapterLink($(element).attr("href"), identity.slug) !== expectedUrl,
    ) ||
    readerPostId($) !== identity.postId
  ) {
    throw new Error("Rinko Comics returned content for a different chapter.");
  }
  const chapterTags = $(".chapter-tag").toArray();
  const readerTitles = $(".chapter-title").toArray();
  const statusMessages = $(".status-message").toArray();
  const pageCounts = $(".pages-count").toArray();
  const readerTitleElement = $(readerTitles[0]!);
  const titleTagElements = readerTitleElement.children(".chapter-tag.free").toArray();
  const titleElementChildren = readerTitleElement.children().toArray();
  const titleContents = readerTitleElement.contents().toArray();
  const titleTag = titleTagElements[0];
  const hasUnexpectedTitleContent = titleContents.some(
    (node) => node.type !== "text" && node !== titleTag,
  );
  if (
    chapterTags.length !== 1 ||
    chapterTags[0] !== titleTag ||
    titleTagElements.length !== 1 ||
    titleElementChildren.length !== 1 ||
    hasUnexpectedTitleContent ||
    readerTitles.length !== 1 ||
    statusMessages.length !== 1 ||
    pageCounts.length !== 1 ||
    cleanText($(statusMessages[0]!).text(), 128) !== "Ready to read"
  ) {
    throw new Error("This chapter is not publicly readable on Rinko Comics.");
  }
  const readerTitle = cleanText(
    titleContents.flatMap((node) => (node.type === "text" ? [$(node).text()] : [])).join(""),
    MAX_TITLE_LENGTH,
  );
  if (readerTitle !== trustedSiteTitle) {
    throw new Error("Rinko Comics returned content for a different chapter title.");
  }
  const countText = cleanText($(pageCounts[0]!).text(), 64);
  const countMatch = countText?.match(/^([1-9]\d*) pages?$/);
  const declaredCount = nonNegativeInteger(countMatch?.[1], MAX_READER_PAGES);
  const flows = $(".chapter-images-section .chapter-images-outer .images-flow").toArray();
  const flow = $(flows[0]!);
  const allChildren = flow.children().toArray();
  const elements = flow.children("img.chapter-image.lazy-image[data-page][data-src]").toArray();
  const hasUnexpectedText = flow
    .contents()
    .toArray()
    .some((node) => node.type === "text" && $(node).text().trim().length > 0);
  if (
    flows.length !== 1 ||
    allChildren.length !== elements.length ||
    hasUnexpectedText ||
    !declaredCount ||
    elements.length !== declaredCount ||
    elements.length > MAX_READER_PAGES
  ) {
    throw new Error("Rinko Comics returned an invalid reader page count.");
  }
  const pages: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < elements.length; index += 1) {
    const image = $(elements[index]!);
    const page = nonNegativeInteger(image.attr("data-page"), MAX_READER_PAGES);
    const url = resolveHttpsUrl(image.attr("data-src"), DOMAIN);
    if (page !== index + 1 || !url || !isRinkoMediaUrl(url) || seen.has(url)) {
      throw new Error("Rinko Comics returned an invalid chapter image entry.");
    }
    seen.add(url);
    pages.push(url);
  }
  return { id: chapterId, mangaId, pages };
};

export const cloneChapterRow = (row: RinkoChapterRow): RinkoChapterRow => ({
  ...row,
  ...(row.publishDate && { publishDate: new IntrinsicDate(dateGetTime(row.publishDate)) }),
});

export const sortChapterRows = (rows: readonly RinkoChapterRow[]): RinkoChapterRow[] =>
  rows
    .map(cloneChapterRow)
    .sort(
      (left, right) => left.chapNum - right.chapNum || Number(left.postId) - Number(right.postId),
    );

export const sortGenres = (genres: readonly RinkoGenre[]): RinkoGenre[] =>
  genres
    .map((genre) => ({ ...genre }))
    .sort(
      (left, right) =>
        compareText(left.title.toLowerCase(), right.title.toLowerCase()) ||
        compareText(left.id, right.id),
    );
