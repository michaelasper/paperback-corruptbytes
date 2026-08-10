import {
  ContentRating,
  URL as PaperbackURL,
  type Chapter,
  type ChapterDetails,
  type SourceManga,
  type Tag,
} from "@paperback/types";

import { paragraphsToXhtml, plainTextFromHtml } from "../shared/html.js";
import {
  decodePaperbackIdComponent,
  encodePaperbackIdComponent,
  validateOpaqueId,
} from "../shared/ids.js";
import type {
  AtsumaruCard,
  AtsumaruCatalogPage,
  AtsumaruFilterOptions,
  AtsumaruHomePage,
  AtsumaruSearchPage,
  AtsumaruTag,
  AtsumaruTaxonomy,
} from "./models.js";

/**
 * Atsumaru's public API is JSON, but the source receives it at an unknown
 * boundary.  These small structural types deliberately live here so parsers
 * remain useful before (and independently of) the network/client layer.
 */
export type AtsumaruScanlatorMap =
  | ReadonlyMap<string, AtsumaruScanlator | string>
  | Readonly<Record<string, AtsumaruScanlator | string>>;

interface AtsumaruScanlator {
  id: string;
  name: string;
}

export type {
  AtsumaruCard,
  AtsumaruCatalogPage,
  AtsumaruFilterOptions,
  AtsumaruHomePage,
  AtsumaruSearchPage,
  AtsumaruTag,
  AtsumaruTaxonomy,
};

const SITE_ORIGIN = "https://atsu.moe";
const CDN_ORIGIN = "https://cdn.atsu.moe";
const FALLBACK_IMAGE_URL = `${SITE_ORIGIN}/favicon.ico`;
const ALLOWED_IMAGE_HOSTS = new Set(["atsu.moe", "cdn.atsu.moe"]);

const MAX_TEXT_LENGTH = 100_000;
const MAX_TITLE_LENGTH = 2_000;
const MAX_URL_LENGTH = 4_096;
const MAX_TAXONOMY_ITEMS = 20_000;
const MAX_LIST_ITEMS = 20_000;
const MAX_PAGE_ITEMS = 10_000;
const MAX_PARAGRAPHS = 4_096;
const MAX_PARAGRAPH_TEXT = 100_000;
const MAX_NOVEL_TEXT = 1_000_000;

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asRecord = (value: unknown): JsonRecord | undefined => (isRecord(value) ? value : undefined);

const boundedArray = (value: unknown, max: number): unknown[] | undefined =>
  Array.isArray(value) ? value.slice(0, max) : undefined;

const text = (value: unknown, max = MAX_TEXT_LENGTH): string | undefined => {
  if (typeof value !== "string" || value.length > max) return undefined;
  const result = value
    .replace(/\u00a0/g, " ")
    .replace(/[ \t\r\n]+/g, " ")
    .trim();
  return result.length > 0 && result.length <= max ? result : undefined;
};

const rawText = (value: unknown, max = MAX_TEXT_LENGTH): string | undefined => {
  if (typeof value !== "string" || value.length > max) return undefined;
  const result = value.trim();
  return result.length > 0 && result.length <= max ? result : undefined;
};

/** Validate one raw API ID without slugifying, case-folding, or otherwise changing it. */
const opaqueId = (value: unknown): string | undefined => {
  return validateOpaqueId(value);
};

/** Encode raw API IDs only at the boundary where Paperback stores them. */
const paperbackIdFromApi = (value: unknown): string | undefined => {
  const id = opaqueId(value);
  return id ? encodePaperbackIdComponent(id) : undefined;
};

/** Recover the raw API value from a Paperback-owned ID before comparing it. */
const apiIdFromPaperback = (value: unknown): string | undefined =>
  typeof value === "string" ? opaqueId(decodePaperbackIdComponent(value)) : undefined;

const finiteNumber = (value: unknown): number | undefined => {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string" || value.length > 128) return undefined;
  const match = value.replaceAll(",", "").match(/-?(?:\d+\.?\d*|\.\d+)/);
  if (!match) return undefined;
  const result = Number(match[0]);
  return Number.isFinite(result) ? result : undefined;
};

const nonNegativeInteger = (value: unknown): number | undefined => {
  const result = finiteNumber(value);
  return result !== undefined && Number.isSafeInteger(result) && result >= 0 ? result : undefined;
};

const booleanValue = (value: unknown): boolean | undefined =>
  typeof value === "boolean"
    ? value
    : typeof value === "string" && /^(?:true|false)$/i.test(value)
      ? value.toLowerCase() === "true"
      : undefined;

const firstText = (record: JsonRecord, keys: readonly string[], max = MAX_TEXT_LENGTH) => {
  for (const key of keys) {
    const candidate = text(record[key], max);
    if (candidate) return candidate;
  }
  return undefined;
};

const error = (message: string): never => {
  throw new Error(`Atsumaru ${message}`);
};

const requireRecord = (value: unknown, message: string): JsonRecord => {
  if (!isRecord(value)) throw new Error(`Atsumaru ${message}`);
  return value;
};

const requireEnvelopeArray = (value: unknown, key: string, max: number): unknown[] => {
  const record = requireRecord(value, "returned an invalid response envelope.");
  const result = boundedArray(record[key], max);
  if (!result) throw new Error(`Atsumaru returned an invalid ${key} list.`);
  return result;
};

const tagName = (value: { name: string; title?: string }): string => value.title ?? value.name;

const compareTags = (
  left: { id: string; name: string; title?: string },
  right: { id: string; name: string; title?: string },
) => tagName(left).localeCompare(tagName(right)) || left.id.localeCompare(right.id);

const countField = (record: JsonRecord, keys: readonly string[]): number | undefined => {
  for (const key of keys) {
    const value = nonNegativeInteger(record[key]);
    if (value !== undefined) return value;
  }
  return undefined;
};

const taxonomyTag = (value: unknown): AtsumaruTag | undefined => {
  const record = asRecord(value);
  if (!record) return undefined;
  const id = taxonomyId(record.id);
  const title = firstText(record, ["name", "title"], MAX_TITLE_LENGTH);
  if (!id || !title) return undefined;
  const result: AtsumaruTag = { id, name: title };
  const explicitTitle = text(record.title, MAX_TITLE_LENGTH);
  const group = text(record.group, MAX_TITLE_LENGTH);
  const namePath = text(record.namePath, MAX_TITLE_LENGTH);
  const adult = booleanValue(record.adult);
  const safeCount = nonNegativeInteger(record.safeCount);
  const adultCount = nonNegativeInteger(record.adultCount);
  if (explicitTitle) result.title = explicitTitle;
  if (group) result.group = group;
  if (namePath) {
    (result as AtsumaruTag & { namePath?: string }).namePath = namePath;
  }
  if (adult !== undefined) result.adult = adult;
  if (safeCount !== undefined) result.safeCount = safeCount;
  if (adultCount !== undefined) result.adultCount = adultCount;
  return result;
};

const taxonomyId = (value: unknown): string | undefined => {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  return opaqueId(value);
};

const simpleTag = (value: unknown): AtsumaruTaxonomy | undefined => {
  const parsed = taxonomyTag(value);
  return parsed ? { id: parsed.id, name: parsed.name } : undefined;
};

const dedupeAndSortTags = <T extends { id: string; name: string; title?: string }>(
  values: T[],
): T[] => {
  const byId = new Map<string, T>();
  for (const value of values) {
    if (!byId.has(value.id)) byId.set(value.id, value);
  }
  return [...byId.values()].sort(compareTags);
};

/** Parse the taxonomy endpoint and retain tag safety/group metadata. */
export const parseAvailableFilters = (value: unknown): AtsumaruFilterOptions => {
  const genres = requireEnvelopeArray(value, "genres", MAX_TAXONOMY_ITEMS)
    .map(simpleTag)
    .filter((item): item is AtsumaruTaxonomy => item !== undefined);
  const statuses = requireEnvelopeArray(value, "statuses", MAX_TAXONOMY_ITEMS)
    .map(simpleTag)
    .filter((item): item is AtsumaruTaxonomy => item !== undefined);
  const types = requireEnvelopeArray(value, "types", MAX_TAXONOMY_ITEMS)
    .map(simpleTag)
    .filter((item): item is AtsumaruTaxonomy => item !== undefined);
  const tags = requireEnvelopeArray(value, "tags", MAX_TAXONOMY_ITEMS)
    .map(taxonomyTag)
    .filter((item): item is AtsumaruTag => item !== undefined);
  return {
    genres: dedupeAndSortTags(genres),
    statuses: dedupeAndSortTags(statuses),
    tags: dedupeAndSortTags(tags),
    types: dedupeAndSortTags(types),
  };
};

const normalizeRating = (value: unknown): number | undefined => {
  const rating = finiteNumber(value);
  if (rating === undefined || rating < 0 || rating > 10) return undefined;
  return rating / 10;
};

const normalizeViews = (value: unknown): number | undefined => {
  if (typeof value === "string") {
    const cleaned = value.trim().replaceAll(",", "");
    const match = cleaned.match(/^(\d+(?:\.\d+)?)([kmb])?$/i);
    if (match) {
      const base = Number(match[1]);
      const suffix = match[2]?.toLocaleLowerCase();
      const multiplier =
        suffix === "k" ? 1_000 : suffix === "m" ? 1_000_000 : suffix === "b" ? 1_000_000_000 : 1;
      const result = base * multiplier;
      return Number.isFinite(result) && result >= 0 ? Math.trunc(result) : undefined;
    }
  }
  const views = finiteNumber(value);
  return views !== undefined && views >= 0 ? Math.trunc(views) : undefined;
};

const normalizeDate = (value: unknown): Date | undefined => {
  const millis = finiteNumber(value);
  if (millis === undefined || millis < 0 || millis > 8640000000000000) return undefined;
  const result = new Date(millis);
  return Number.isNaN(result.getTime()) ? undefined : result;
};

/**
 * Parse the two timestamp widths used by Atsumaru chapter records.
 *
 * Chapter timestamps are normally thirteen-digit epoch milliseconds.  Some
 * records use clean ten-digit epoch seconds; normalize those only when the
 * complete value is numeric so values such as `1700000000000oops` cannot be
 * accepted by the permissive general-purpose number parser.
 */
const chapterTimestamp = (value: unknown): number | undefined => {
  let digits: string;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) return undefined;
    digits = String(value);
  } else if (typeof value === "string") {
    digits = value.trim();
    if (!/^\d+$/.test(digits)) return undefined;
  } else {
    return undefined;
  }

  if (digits.length !== 10 && digits.length !== 13) return undefined;
  const numeric = Number(digits);
  if (!Number.isSafeInteger(numeric)) return undefined;
  const millis = digits.length === 10 ? numeric * 1_000 : numeric;
  if (!Number.isSafeInteger(millis) || millis < 0 || millis > 8640000000000000) {
    return undefined;
  }
  const date = new Date(millis);
  return Number.isNaN(date.getTime()) ? undefined : millis;
};

export interface AtsumaruRatingDocument {
  id: string;
  isAdult?: boolean;
  mbContentRating?: string;
}

const contentRatingFromMbValue = (value: unknown): ContentRating | undefined => {
  const normalized = rawText(value, MAX_TITLE_LENGTH)?.replace(/\s+/g, " ").toLocaleLowerCase();
  switch (normalized) {
    case "safe":
    case "everyone":
    case "general":
    case "all ages":
      return ContentRating.EVERYONE;
    case "suggestive":
    case "mature":
      return ContentRating.MATURE;
    case "erotica":
    case "pornographic":
    case "adult":
      return ContentRating.ADULT;
    default:
      return undefined;
  }
};

/** Parse and verify the reduced Typesense document used for detail ratings. */
export const parseMangaRatingDocument = (
  value: unknown,
  requestedId: string,
): AtsumaruRatingDocument | undefined => {
  const record = asRecord(value);
  const responseId = opaqueId(record?.id);
  const requested = apiIdFromPaperback(requestedId);
  if (!responseId || !requested || responseId !== requested) return undefined;
  const isAdult = booleanValue(record?.isAdult);
  const mbContentRating = rawText(record?.mbContentRating, MAX_TITLE_LENGTH);
  return {
    id: responseId,
    ...(isAdult !== undefined && { isAdult }),
    ...(mbContentRating !== undefined && { mbContentRating }),
  };
};

const authoritativeContentRating = (value: unknown): ContentRating | undefined => {
  const record = asRecord(value) ?? {};
  if (booleanValue(record.isAdult) === true) return ContentRating.ADULT;
  for (const key of ["mbContentRating", "contentRating", "classification"]) {
    const rating = contentRatingFromMbValue(record[key]);
    if (rating !== undefined) return rating;
  }
  return undefined;
};

/** Derive a Paperback content rating without understating an unknown audience. */
export const contentRatingForAtsumaru = (value: unknown): ContentRating => {
  return authoritativeContentRating(value) ?? ContentRating.MATURE;
};

// Short alias useful to callers that do not need the source name in the helper.
export const parseContentRating = contentRatingForAtsumaru;

const imagePathFrom = (rawValue: string): string | undefined => {
  const raw = rawValue.trim();
  if (!raw || raw.length > MAX_URL_LENGTH || /[\s\0\\?#]/.test(raw)) return undefined;
  if (/%(?:2e|2f|5c)/i.test(raw)) return undefined;

  let path: string;
  if (/^[a-z][a-z\d+.-]*:/i.test(raw) || raw.startsWith("//")) {
    let parsed: PaperbackURL;
    try {
      parsed = new PaperbackURL(raw.startsWith("//") ? `https:${raw}` : raw);
    } catch {
      return undefined;
    }
    if (
      parsed.protocol.toLowerCase().replace(/:$/, "") !== "https" ||
      !ALLOWED_IMAGE_HOSTS.has(parsed.hostname.toLowerCase()) ||
      parsed.username ||
      parsed.password ||
      parsed.queryItems !== undefined ||
      parsed.fragment !== undefined
    ) {
      return undefined;
    }
    path = parsed.path;
  } else {
    if (/^[a-z][a-z\d+.-]*:/i.test(raw)) return undefined;
    path = raw;
  }

  // Check the original path before URL normalization can hide traversal.
  let decodedPath = path;
  let stable = false;
  for (let pass = 0; pass < 8; pass += 1) {
    try {
      const next = decodeURIComponent(decodedPath);
      if (next === decodedPath) {
        stable = true;
        break;
      }
      decodedPath = next;
    } catch {
      return undefined;
    }
  }
  if (!stable) return undefined;
  if (
    /[\\\0]/.test(decodedPath) ||
    decodedPath.split("/").some((part) => part === "." || part === "..")
  ) {
    return undefined;
  }
  path = decodedPath.replace(/^\/+/, "");
  if (path.startsWith("static/")) {
    // already canonical
  } else if (/^(?:posters|pages|banners)\//.test(path)) {
    path = `static/${path}`;
  } else {
    return undefined;
  }
  const segments = path.split("/");
  if (
    segments.length < 3 ||
    segments[0] !== "static" ||
    !/^(?:posters|pages|banners)$/.test(segments[1] ?? "") ||
    segments.some(
      (segment) => !segment || segment === "." || segment === ".." || segment.includes(":"),
    )
  ) {
    return undefined;
  }
  return `/${segments.map((segment) => encodeURIComponent(segment)).join("/")}`;
};

/** Normalize an Atsumaru image path to the direct CDN, or return undefined. */
export const normalizeAtsumaruImage = (value: unknown): string | undefined => {
  const candidate = rawText(value, MAX_URL_LENGTH);
  const path = candidate ? imagePathFrom(candidate) : undefined;
  return path ? `${CDN_ORIGIN}${path}` : undefined;
};

const imageFrom = (record: JsonRecord | undefined, keys: readonly string[]): string => {
  if (!record) return FALLBACK_IMAGE_URL;
  for (const key of keys) {
    const image = normalizeAtsumaruImage(record[key]);
    if (image) return image;
  }
  return FALLBACK_IMAGE_URL;
};

const imageFields = (record: JsonRecord): JsonRecord | undefined => {
  const poster = asRecord(record.poster);
  if (poster) return poster;
  return record;
};

const contentTypeFrom = (record: JsonRecord): "comic" | "novel" | undefined => {
  const medium = firstText(record, ["medium", "format"], MAX_TITLE_LENGTH);
  const type = firstText(record, ["type", "contentType"], MAX_TITLE_LENGTH);
  if (medium && /^novel$/i.test(medium)) return "novel";
  if (type && /^novel$/i.test(type)) return "novel";
  if (medium || type) return "comic";
  return undefined;
};

const cardFrom = (value: unknown): AtsumaruCard | undefined => {
  const record = asRecord(value);
  if (!record) return undefined;
  const mangaId = paperbackIdFromApi(record.id);
  const title = firstText(record, ["title", "englishTitle"], MAX_TITLE_LENGTH);
  if (!mangaId || !title) return undefined;
  const poster = imageFields(record);
  const contentType = contentTypeFrom(record);
  const type = firstText(record, ["type"], MAX_TITLE_LENGTH);
  const medium = firstText(record, ["medium"], MAX_TITLE_LENGTH);
  const status = firstText(record, ["status"], MAX_TITLE_LENGTH);
  const rating = normalizeRating(record.mbRating ?? record.avgRating ?? record.rating);
  const views = normalizeViews(record.views);
  const releaseDate = normalizeDate(record.releaseDate ?? record.released);
  const directYear = nonNegativeInteger(record.year);
  const year =
    directYear !== undefined && directYear >= 1 && directYear <= 9999
      ? directYear
      : releaseDate?.getUTCFullYear();
  const chapterCount = countField(record, ["chapterCount", "totalChapterCount"]);
  const officialTranslation = booleanValue(record.officialTranslation);
  const result: AtsumaruCard = {
    mangaId,
    title,
    imageUrl: imageFrom(poster, [
      "mediumImage",
      "posterMedium",
      "largeImage",
      "poster",
      "image",
      "smallImage",
      "posterSmall",
    ]),
    contentRating: contentRatingForAtsumaru(record),
  };
  if (contentType) result.contentType = contentType;
  if (type) result.type = type;
  if (medium) result.medium = medium;
  const isAdult = booleanValue(record.isAdult);
  if (isAdult !== undefined) result.isAdult = isAdult;
  if (status) result.status = status;
  if (rating !== undefined) result.rating = rating;
  if (views !== undefined) result.views = views;
  if (year !== undefined) result.year = year;
  if (chapterCount !== undefined) result.chapterCount = chapterCount;
  if (officialTranslation !== undefined) result.officialTranslation = officialTranslation;
  return result;
};

const documentFromHit = (value: unknown): JsonRecord | undefined => {
  const hit = asRecord(value);
  return hit ? asRecord(hit.document) : undefined;
};

/** Parse Typesense-style search output. Malformed hits are intentionally skipped. */
export const parseSearchResponse = (value: unknown): AtsumaruSearchPage => {
  const record = requireRecord(value, "returned an invalid search response envelope.");
  const found = nonNegativeInteger(record.found);
  const page = nonNegativeInteger(record.page);
  const hits = boundedArray(record.hits, MAX_LIST_ITEMS);
  if (found === undefined || page === undefined || page < 1 || !hits) {
    throw new Error("Atsumaru returned an invalid search response envelope.");
  }
  const validFound = found;
  const validPage = page;
  const validHits = hits;
  const items: AtsumaruCard[] = [];
  for (const hit of validHits) {
    const item = cardFrom(documentFromHit(hit));
    if (item) items.push(item);
  }
  const requestParams = asRecord(record.request_params);
  const perPage =
    countField(record, ["perPage", "per_page", "limit"]) ??
    (requestParams ? countField(requestParams, ["perPage", "per_page", "limit"]) : undefined);
  const hasNextPage =
    perPage !== undefined
      ? validPage * perPage < validFound
      : validPage * validHits.length < validFound;
  return { items, page: validPage, totalCount: validFound, hasNextPage };
};

/** Parse home/feed output. Feed records never receive synthetic chapter IDs. */
export const parseFeedResponse = (value: unknown): AtsumaruHomePage => {
  const items = requireEnvelopeArray(value, "items", MAX_LIST_ITEMS);
  return {
    items: items.flatMap((item): AtsumaruCard[] => {
      const parsed = cardFrom(item);
      return parsed ? [parsed] : [];
    }),
  };
};

const titleKey = (value: string): string => value.normalize("NFKC").toLocaleLowerCase();

const uniqueTitles = (primary: string, values: unknown[]): string[] => {
  const seen = new Set([titleKey(primary)]);
  const output: string[] = [];
  for (const value of values) {
    const candidate = text(value, MAX_TITLE_LENGTH);
    if (!candidate) continue;
    const key = titleKey(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(candidate);
  }
  return output;
};

const tagGroupsFrom = (record: JsonRecord): { id: string; title: string; tags: Tag[] }[] => {
  const groups = new Map<string, { id: string; title: string; tags: Tag[]; ids: Set<string> }>();
  const add = (value: unknown, groupId: string, groupTitle: string): void => {
    const tag = taxonomyTag(value);
    if (!tag) return;
    const safeGroupId = encodePaperbackIdComponent(groupId);
    let group = groups.get(safeGroupId);
    if (!group) {
      group = { id: safeGroupId, title: groupTitle, tags: [], ids: new Set<string>() };
      groups.set(safeGroupId, group);
    }
    if (group.ids.has(tag.id)) return;
    group.ids.add(tag.id);
    group.tags.push({ id: tag.id, title: tagName(tag) });
  };

  const genres = boundedArray(record.genres, MAX_PAGE_ITEMS) ?? [];
  for (const genre of genres) add(genre, "genres", "Genres");

  const tags = boundedArray(record.tags, MAX_PAGE_ITEMS) ?? [];
  for (const value of tags) {
    const tag = taxonomyTag(value);
    if (!tag) continue;
    const path = (tag as AtsumaruTag & { namePath?: string }).namePath ?? "Tags";
    const root = path.split(/\s*>\s*|\s*\/\s*/)[0]?.trim() || "Tags";
    add(tag, root, root);
  }
  return [...groups.values()]
    .map((group) => ({
      id: group.id,
      title: group.title,
      tags: group.tags.sort(
        (left, right) => left.title.localeCompare(right.title) || left.id.localeCompare(right.id),
      ),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
};

const authorNames = (record: JsonRecord, type: "Author" | "Artist"): string | undefined => {
  const authors = boundedArray(record.authors, MAX_PAGE_ITEMS) ?? [];
  const seen = new Set<string>();
  const names: string[] = [];
  for (const item of authors) {
    const author = asRecord(item);
    if (
      !author ||
      text(author.type, MAX_TITLE_LENGTH)?.toLocaleLowerCase() !== type.toLowerCase()
    ) {
      continue;
    }
    const name = text(author.name, MAX_TITLE_LENGTH);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names.length > 0 ? names.join(", ") : undefined;
};

/** Parse a detail page and preserve the requested opaque ID exactly. */
export const parseMangaPage = (
  value: unknown,
  requestedId: string,
  ratingDocument?: AtsumaruRatingDocument | null,
): SourceManga => {
  const envelope = requireRecord(value, "returned an invalid manga page envelope.");
  const page = requireRecord(envelope.mangaPage, "returned a null or invalid mangaPage.");
  const responseId = opaqueId(page.id);
  const requested = apiIdFromPaperback(requestedId);
  if (!responseId || !requested || responseId !== requested) {
    throw new Error("Atsumaru manga page ID mismatch.");
  }
  const validResponseId = encodePaperbackIdComponent(responseId);
  const primaryTitle = firstText(page, ["title"], MAX_TITLE_LENGTH);
  const medium = firstText(page, ["medium"], MAX_TITLE_LENGTH);
  const poster = asRecord(page.poster);
  if (!primaryTitle || !medium || !poster) {
    throw new Error("Atsumaru returned malformed manga page fields.");
  }
  const validPrimaryTitle = primaryTitle;
  const validMedium = medium;
  const validPoster = poster;

  const synopsisMarkup =
    typeof page.synopsis === "string" && page.synopsis.length <= MAX_TEXT_LENGTH
      ? page.synopsis
      : "";
  const status = firstText(page, ["status"], MAX_TITLE_LENGTH);
  const released = normalizeDate(page.released);
  const avgRating = finiteNumber(page.avgRating);
  const views =
    rawText(page.views, MAX_TITLE_LENGTH) ??
    (finiteNumber(page.views) !== undefined ? String(page.views) : undefined);
  const totalChapterCount = nonNegativeInteger(page.totalChapterCount);
  const secondaryValues = [
    page.englishTitle,
    ...(boundedArray(page.otherNames, MAX_PAGE_ITEMS) ?? []),
  ];
  const additionalInfo: Record<string, string> = { format: validMedium };
  if (released) additionalInfo.year = String(released.getUTCFullYear());
  if (views) additionalInfo.views = views;
  if (totalChapterCount !== undefined) additionalInfo.chapters = String(totalChapterCount);
  const mangaInfo: SourceManga["mangaInfo"] = {
    primaryTitle: validPrimaryTitle,
    secondaryTitles: uniqueTitles(validPrimaryTitle, secondaryValues),
    thumbnailUrl: imageFrom(validPoster, ["mediumImage", "largeImage", "image", "smallImage"]),
    synopsis: synopsisMarkup ? plainTextFromHtml(synopsisMarkup) : "",
    contentRating: authoritativeContentRating(ratingDocument) ?? contentRatingForAtsumaru(page),
    contentType: /^novel$/i.test(validMedium) ? "novel" : "comic",
    shareUrl: `${SITE_ORIGIN}/${/^novel$/i.test(validMedium) ? "novel" : "manga"}/${validResponseId}`,
    additionalInfo,
  };
  if (avgRating !== undefined && avgRating >= 0 && avgRating <= 10)
    mangaInfo.rating = avgRating / 10;
  const tagGroups = tagGroupsFrom(page);
  if (tagGroups.length > 0) mangaInfo.tagGroups = tagGroups;
  if (status) mangaInfo.status = status;
  const banner = asRecord(page.banner);
  const bannerUrl = imageFrom(banner, ["url", "image", "largeImage"]);
  if (bannerUrl !== FALLBACK_IMAGE_URL) mangaInfo.bannerUrl = bannerUrl;
  const author = authorNames(page, "Author");
  const artist = authorNames(page, "Artist");
  if (author) mangaInfo.author = author;
  if (artist) mangaInfo.artist = artist;
  const scanlators = (boundedArray(page.scanlators, MAX_PAGE_ITEMS) ?? [])
    .map((item) => asRecord(item))
    .map((item) => (item ? text(item.name, MAX_TITLE_LENGTH) : undefined))
    .filter((name): name is string => Boolean(name));
  if (scanlators.length > 0) additionalInfo.scanlators = [...new Set(scanlators)].join(", ");
  return { mangaId: validResponseId, mangaInfo };
};

/** Extract a safe exact-ID scanlator lookup from a manga page response. */
export const parseScanlators = (value: unknown): Record<string, string> => {
  const envelope = asRecord(value);
  const page = envelope ? (asRecord(envelope.mangaPage) ?? envelope) : undefined;
  const entries = boundedArray(page?.scanlators, MAX_PAGE_ITEMS) ?? [];
  const names = new Map<string, string>();
  const conflicting = new Set<string>();
  for (const item of entries) {
    const record = asRecord(item);
    const id = opaqueId(record?.id);
    const name = record ? text(record.name, MAX_TITLE_LENGTH) : undefined;
    if (!id || !name) continue;
    const previous = names.get(id);
    if (previous !== undefined && previous !== name) conflicting.add(id);
    else if (previous === undefined) names.set(id, name);
  }
  for (const id of conflicting) names.delete(id);
  return Object.fromEntries(names);
};

const chapterContextId = (chapter: Chapter): string => {
  const id = apiIdFromPaperback(chapter.chapterId);
  if (!id) throw new Error("Atsumaru received a chapter with an invalid ID.");
  return id;
};

const scanlatorFromMap = (
  map: AtsumaruScanlatorMap | undefined,
  id: string | undefined,
): AtsumaruScanlator | undefined => {
  if (!id) return undefined;
  if (map) {
    const value = map instanceof Map ? map.get(id) : (map as Readonly<Record<string, unknown>>)[id];
    if (typeof value === "string") return { id, name: value };
    const record = asRecord(value);
    const name = record ? text(record.name, MAX_TITLE_LENGTH) : undefined;
    const mappedId = record ? opaqueId(record.id) : undefined;
    if (name) return { id: mappedId ?? id, name };
  }
  // Library entries created before scanlator metadata was persisted still need
  // a version. Paperback uses it to keep translations distinct while merging
  // chapters; the exact upstream ID is stable and collision-free.
  return { id, name: `Scanlation ${id}` };
};

const chapterTitle = (value: string, number: number): string | undefined => {
  const escaped = String(number).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const stripped = value
    .replace(new RegExp(`^chapter\\s*(?:#\\s*)?${escaped}(?=\\s|$)`, "i"), "")
    .replace(/^\s*[-–—:]+\s*/, "")
    .trim();
  return stripped || undefined;
};

interface ChapterCandidate {
  id: string;
  number: number;
  /** Explicit API index; absent indices sort by their input position. */
  apiIndex?: number;
  inputIndex: number;
  createdAt?: number;
  title?: string;
  scanlationId?: string;
  scanlator?: AtsumaruScanlator;
}

/** Compare only fields that can affect the mapped Chapter or its ordering. */
const sameChapterCandidate = (left: ChapterCandidate, right: ChapterCandidate): boolean => {
  return (
    left.id === right.id &&
    left.number === right.number &&
    left.apiIndex === right.apiIndex &&
    left.createdAt === right.createdAt &&
    left.title === right.title &&
    left.scanlationId === right.scanlationId &&
    left.scanlator?.name === right.scanlator?.name
  );
};

/** Parse chapter list output while retaining duplicate chapter numbers and IDs. */
export const parseChapters = (
  value: unknown,
  sourceManga: SourceManga,
  scanlatorMap?: AtsumaruScanlatorMap,
): Chapter[] => {
  const records = requireEnvelopeArray(value, "chapters", MAX_LIST_ITEMS);
  const byId = new Map<string, ChapterCandidate>();
  const conflicting = new Set<string>();
  records.forEach((item, inputIndex) => {
    const record = asRecord(item);
    if (!record) return;
    const id = paperbackIdFromApi(record.id);
    const rawTitle = firstText(record, ["title"], MAX_TITLE_LENGTH);
    const number = finiteNumber(record.number);
    const createdAt = chapterTimestamp(record.createdAt);
    const scanlationId = opaqueId(record.scanlationMangaId);
    if (!id || number === undefined || !Number.isFinite(number)) return;
    const apiIndex = nonNegativeInteger(record.index);
    const scanlator = scanlatorFromMap(scanlatorMap, scanlationId);
    const candidate: ChapterCandidate = {
      id,
      number,
      inputIndex,
      ...(apiIndex !== undefined && { apiIndex }),
      ...(rawTitle && { title: chapterTitle(rawTitle, number) }),
      ...(createdAt !== undefined && { createdAt }),
      ...(scanlationId && { scanlationId }),
      ...(scanlator && { scanlator }),
    };
    const existing = byId.get(id);
    if (!existing) {
      byId.set(id, candidate);
    } else if (!sameChapterCandidate(existing, candidate)) {
      conflicting.add(id);
    }
  });

  const candidates = [...byId.values()]
    .filter((candidate) => !conflicting.has(candidate.id))
    .sort(
      (left, right) =>
        left.number - right.number ||
        (left.apiIndex ?? left.inputIndex) - (right.apiIndex ?? right.inputIndex) ||
        (left.createdAt ?? Number.POSITIVE_INFINITY) -
          (right.createdAt ?? Number.POSITIVE_INFINITY) ||
        (left.scanlator?.name ?? "").localeCompare(right.scanlator?.name ?? "") ||
        left.id.localeCompare(right.id),
    );

  return candidates.map((candidate, sortingIndex): Chapter => {
    const result: Chapter = {
      chapterId: candidate.id,
      sourceManga,
      langCode: "en",
      chapNum: candidate.number,
      ...(candidate.title && { title: candidate.title }),
      ...(candidate.scanlator?.name && { version: candidate.scanlator.name }),
      ...(candidate.createdAt !== undefined && { publishDate: new Date(candidate.createdAt) }),
      sortingIndex,
      additionalInfo: {
        ...(candidate.scanlationId && { scanlationId: candidate.scanlationId }),
      },
    };
    return result;
  });
};

const chapterResponse = (value: unknown, key: "readChapter" | "readNovelChapter"): JsonRecord => {
  const envelope = requireRecord(value, "returned an invalid chapter response envelope.");
  return requireRecord(envelope[key], `returned an invalid ${key} response.`);
};

const assertChapterResponseId = (record: JsonRecord, chapter: Chapter): string => {
  const responseId = opaqueId(record.id);
  const requestedId = chapterContextId(chapter);
  if (!responseId || responseId !== requestedId) {
    throw new Error("Atsumaru chapter response ID mismatch.");
  }
  const responseScanlationId = opaqueId(record.scanlationMangaId);
  const expectedScanlationId =
    chapter.additionalInfo?.scanlationId ?? chapter.additionalInfo?.scanlationMangaId;
  if (expectedScanlationId && responseScanlationId !== expectedScanlationId) {
    error("chapter response scanlation ID mismatch.");
  }
  return encodePaperbackIdComponent(responseId);
};

/** Parse a comic reader response into Paperback image pages. */
export const parseComicChapter = (value: unknown, chapter: Chapter): ChapterDetails => {
  const record = chapterResponse(value, "readChapter");
  const id = assertChapterResponseId(record, chapter);
  const pages = boundedArray(record.pages, MAX_PAGE_ITEMS);
  if (!pages) throw new Error("Atsumaru returned an invalid comic pages list.");
  const validPages = pages;
  const candidates: { url: string; number: number; inputIndex: number }[] = [];
  validPages.forEach((item, inputIndex) => {
    const page = asRecord(item);
    if (!page) return;
    const url = normalizeAtsumaruImage(page.image);
    if (!url) return;
    const number = finiteNumber(page.number);
    candidates.push({ url, number: number ?? Number.MAX_SAFE_INTEGER, inputIndex });
  });
  candidates.sort(
    (left, right) => left.number - right.number || left.inputIndex - right.inputIndex,
  );
  const seen = new Set<string>();
  const output = candidates.flatMap((candidate): string[] => {
    if (seen.has(candidate.url)) return [];
    seen.add(candidate.url);
    return [candidate.url];
  });
  if (output.length === 0) error("returned no readable comic pages.");
  return { id, mangaId: chapter.sourceManga.mangaId, pages: output };
};

/** Parse a novel reader response; paragraph values are always treated as text. */
export const parseNovelChapter = (value: unknown, chapter: Chapter): ChapterDetails => {
  const record = chapterResponse(value, "readNovelChapter");
  const id = assertChapterResponseId(record, chapter);
  const paragraphs = boundedArray(record.paragraphs, MAX_PARAGRAPHS);
  if (!paragraphs) throw new Error("Atsumaru returned an invalid novel paragraphs list.");
  const validParagraphs = paragraphs;
  const cleanParagraphs: string[] = [];
  let totalLength = 0;
  for (const paragraph of validParagraphs) {
    if (typeof paragraph !== "string" || paragraph.length > MAX_PARAGRAPH_TEXT) continue;
    const trimmed = paragraph.trim();
    if (!trimmed) continue;
    totalLength += trimmed.length;
    if (totalLength > MAX_NOVEL_TEXT) break;
    cleanParagraphs.push(trimmed);
  }
  if (cleanParagraphs.length === 0) error("returned no readable novel text.");
  return {
    id,
    mangaId: chapter.sourceManga.mangaId,
    type: "html",
    html: paragraphsToXhtml(cleanParagraphs),
  };
};

export { FALLBACK_IMAGE_URL };
