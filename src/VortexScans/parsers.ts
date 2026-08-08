import {
  ContentRating,
  type Chapter,
  type ChapterDetails,
  type MangaInfo,
  type SourceManga,
  type Tag,
} from "@paperback/types";
import { load } from "cheerio";

import type {
  ChapterAccess,
  JsonRecord,
  MangaListItem,
  ParseChapterListOptions,
} from "./models.js";
import { DOMAIN } from "./network.js";

const UNSAFE_PROTOCOL = /^[a-z][a-z\d+.-]*:/i;
const ENCODED_ID_PUNCTUATION = /[!'()*]/g;
const PLACEHOLDER_CREATOR = /^(?:-|–|—|_|n\/a|na|unknown|updating|tba)$/i;
const BLOCK_TAG =
  /<(?:\/)?(?:address|article|blockquote|div|h[1-6]|li|p|pre|section|tr|ul|ol)\b[^>]*>/gi;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asRecord = (value: unknown): JsonRecord => (isRecord(value) ? value : {});

const firstDefined = (record: JsonRecord, keys: string[]): unknown => {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) return record[key];
  }
  return undefined;
};

const asText = (value: unknown): string | undefined => {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  return undefined;
};

const asBoolean = (value: unknown): boolean | undefined => {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "off", ""].includes(normalized)) return false;
  }
  return undefined;
};

const asNumber = (value: unknown): number | undefined => {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().replace(/,/g, "");
  if (!normalized) return undefined;
  const match = normalized.match(/-?\d+(?:\.\d+)?/);
  if (!match) return undefined;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/**
 * Return an absolute HTTP(S) URL, or an empty string for malformed/unsafe input.
 * Relative paths are resolved against the source's public domain.
 */
export const safeUrl = (value: unknown, base: string = DOMAIN): string => {
  const raw = asText(value);
  if (!raw || raw.startsWith("data:") || raw.startsWith("javascript:")) return "";
  if (UNSAFE_PROTOCOL.test(raw) && !/^https?:/i.test(raw)) return "";
  if (!/^https?:\/\//i.test(raw) && !raw.startsWith("//") && !/^\.?\.?\//.test(raw)) return "";

  try {
    const url = new URL(raw, base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    return url.toString();
  } catch {
    return "";
  }
};

/** Encode a slug while making punctuation unambiguous for Paperback IDs. */
export const encodeMangaId = (slug: string, numericId?: number | string | null): string => {
  const normalizedSlug = slug.trim().replace(/^\/+|\/+$/g, "");
  if (!normalizedSlug) throw new Error("Cannot encode an empty Vortex Scans slug");

  const encodedSlug = encodeURIComponent(normalizedSlug).replace(
    ENCODED_ID_PUNCTUATION,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  const id = asText(numericId);
  return id && /^\d+$/.test(id) ? `${encodedSlug}@${id}` : encodedSlug;
};

export interface DecodedMangaIdentifier {
  slug: string;
  numericId?: number;
}

/** Decode a Vortex manga identifier, accepting both `slug@id` and legacy slug-only IDs. */
export const decodeMangaIdentifier = (value: string): DecodedMangaIdentifier => {
  const normalized = value.trim();
  const match = normalized.match(/^(.*)@(\d+)$/);
  const encodedSlug = match?.[1] ?? normalized;
  let slug = encodedSlug;
  try {
    slug = decodeURIComponent(encodedSlug);
  } catch {
    // Preserve the original value if an old/broken extension supplied malformed encoding.
  }

  return match?.[2] === undefined ? { slug } : { slug, numericId: Number(match[2]) };
};

/** Backward-compatible slug-only decoder used by callers that do not need the numeric ID. */
export const decodeMangaId = (value: string): string => decodeMangaIdentifier(value).slug;

export const parseMangaId = decodeMangaIdentifier;
export const safeMangaId = encodeMangaId;

/** Parse a Vortex timestamp without ever returning an invalid Date. */
export const parseDate = (value: unknown): Date | undefined => {
  if (value instanceof Date) {
    const copy = new Date(value.getTime());
    return Number.isNaN(copy.getTime()) ? undefined : copy;
  }

  const number = asNumber(value);
  if (
    number !== undefined &&
    (typeof value === "number" || /^\d+(?:\.\d+)?$/.test(String(value).trim()))
  ) {
    const milliseconds = Math.abs(number) < 1_000_000_000_000 ? number * 1000 : number;
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }

  const text = asText(value);
  if (!text) return undefined;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? undefined : date;
};

const decodeHtmlText = (value: unknown): string => stripHtml(asText(value) ?? "");

/** Strip markup while retaining paragraph and line-break boundaries and decoding entities. */
export const stripHtml = (value: string): string => {
  if (!value) return "";
  const normalized = value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(BLOCK_TAG, (tag) => (tag.startsWith("</") ? `${tag}\n\n` : tag));

  const $ = load(`<div>${normalized}</div>`, null, false);
  const text = $("div")
    .first()
    .text()
    .replace(/\u00a0/g, " ");
  return text
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
};

const normalizeCreator = (value: unknown): string | undefined => {
  const text = decodeHtmlText(value).replace(/\s+/g, " ").trim();
  if (!text || PLACEHOLDER_CREATOR.test(text)) return undefined;
  return text;
};

export const mapStatus = (value: unknown): string | undefined => {
  const text = asText(value);
  if (!text) return undefined;
  switch (text.toUpperCase().replace(/[\s-]+/g, "_")) {
    case "ONGOING":
      return "Ongoing";
    case "HIATUS":
      return "Hiatus";
    case "COMPLETED":
      return "Completed";
    case "CANCELLED":
    case "CANCELED":
      return "Cancelled";
    case "DROPPED":
      return "Dropped";
    case "COMING_SOON":
      return "Coming Soon";
    case "MASS_RELEASED":
      return "Mass Released";
    default:
      return text;
  }
};

const mapType = (value: unknown): "comic" | "novel" =>
  /novel/i.test(asText(value) ?? "") ? "novel" : "comic";

const genreRecords = (value: unknown): JsonRecord[] =>
  asArray(value)
    .map(asRecord)
    .filter((genre) => Boolean(asText(genre.name)));

const tagId = (genre: JsonRecord): string => {
  const id = asText(genre.id);
  if (id) return id;
  return (asText(genre.name) ?? "tag")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
};

export const contentRatingForGenres = (genres: string[]): ContentRating => {
  const normalized = genres.map((genre) => genre.trim().toLowerCase());
  if (
    normalized.some((genre) =>
      /\b(?:adult|hentai|porn(?:ographic)?|shotacon|smut|yaoi|yuri)\b/.test(genre),
    )
  ) {
    return ContentRating.ADULT;
  }
  if (normalized.some((genre) => /\b(?:ecchi|gore|mature|nsfw|violence|violent)\b/.test(genre))) {
    return ContentRating.MATURE;
  }
  return ContentRating.EVERYONE;
};

export const contentRatingForManga = (manga: JsonRecord): ContentRating => {
  const explicit = asText(manga.contentRating)?.toUpperCase();
  if (explicit === ContentRating.ADULT || ["ADULT", "R18", "18+"].includes(explicit ?? "")) {
    return ContentRating.ADULT;
  }
  if (explicit === ContentRating.MATURE || ["MATURE", "R15", "16+"].includes(explicit ?? "")) {
    return ContentRating.MATURE;
  }
  if (explicit === ContentRating.EVERYONE || explicit === "SAFE" || explicit === "EVERYONE") {
    return ContentRating.EVERYONE;
  }

  const genres = genreRecords(firstDefined(manga, ["genres", "tags"])).map(
    (genre) => asText(genre.name) ?? "",
  );
  return contentRatingForGenres(genres);
};

const extractManga = (value: unknown): JsonRecord => {
  if (!isRecord(value)) return {};
  if (isRecord(value.post)) return value.post;
  if (isRecord(value.manga)) return value.manga;
  if (isRecord(value.series)) return value.series;
  if (isRecord(value.data) && !Array.isArray(value.data)) return value.data;
  return value;
};

const extractMangaList = (value: unknown): JsonRecord[] => {
  if (Array.isArray(value)) return value.filter(isRecord);
  if (!isRecord(value)) return [];

  for (const key of ["posts", "data", "results", "series"]) {
    const values = value[key];
    if (Array.isArray(values)) return values.filter(isRecord);
    if (isRecord(values)) {
      const nested = extractMangaList(values);
      if (nested.length > 0) return nested;
    }
  }
  if (isRecord(value.post) || isRecord(value.manga) || isRecord(value.series)) {
    return [extractManga(value)];
  }
  return [];
};

const extractChapterList = (value: unknown): JsonRecord[] => {
  if (Array.isArray(value)) return value.filter(isRecord);
  if (!isRecord(value)) return [];
  if (isRecord(value.post) && Array.isArray(value.post.chapters)) {
    return value.post.chapters.filter(isRecord);
  }
  for (const key of ["chapters", "data", "results"]) {
    const values = value[key];
    if (Array.isArray(values)) return values.filter(isRecord);
    if (isRecord(values) && Array.isArray(values.chapters)) return values.chapters.filter(isRecord);
  }
  return [];
};

const postSlug = (manga: JsonRecord): string | undefined =>
  asText(firstDefined(manga, ["slug", "seriesSlug", "mangaSlug", "postSlug", "series_slug"]));

const postId = (manga: JsonRecord): string | undefined =>
  asText(firstDefined(manga, ["id", "postId", "seriesId", "mangaId", "post_id"]));

const mangaIdFor = (manga: JsonRecord, requestedId?: string): string => {
  if (requestedId?.trim()) return requestedId.trim();
  const slug = postSlug(manga);
  if (!slug) throw new Error("Vortex Scans response did not contain a manga slug");
  return encodeMangaId(slug, postId(manga));
};

const chapterNumber = (chapter: JsonRecord): number => {
  const direct = asNumber(chapter.number);
  if (direct !== undefined) return direct;
  const source = `${asText(chapter.slug) ?? ""} ${asText(chapter.title) ?? ""}`;
  return asNumber(source) ?? 0;
};

const dateValue = (chapter: JsonRecord): Date | undefined =>
  parseDate(firstDefined(chapter, ["createdAt", "publishedAt", "updatedAt", "releaseDate"]));

const compareStable = (left: JsonRecord, right: JsonRecord): number => {
  const numberDifference = chapterNumber(left) - chapterNumber(right);
  if (numberDifference !== 0) return numberDifference;

  const leftDate = dateValue(left)?.getTime() ?? 0;
  const rightDate = dateValue(right)?.getTime() ?? 0;
  if (leftDate !== rightDate) return leftDate - rightDate;

  const leftId = asText(firstDefined(left, ["id", "chapterId"])) ?? "";
  const rightId = asText(firstDefined(right, ["id", "chapterId"])) ?? "";
  const leftNumeric = asNumber(leftId);
  const rightNumeric = asNumber(rightId);
  if (leftNumeric !== undefined && rightNumeric !== undefined && leftNumeric !== rightNumeric) {
    return leftNumeric - rightNumeric;
  }
  return leftId.localeCompare(rightId);
};

const splitAlternateTitles = (value: unknown): string[] => {
  const rawTitles = Array.isArray(value)
    ? value.map(asText).filter((title): title is string => Boolean(title))
    : [asText(value) ?? ""];
  return rawTitles
    .flatMap((title) => title.split(/\s*(?:,|\||;|\n|\r|\s+\/\s+)\s*/))
    .map((title) => decodeHtmlText(title))
    .filter(Boolean);
};

const uniqueTitles = (primaryTitle: string, alternateTitles: unknown): string[] => {
  const seen = new Set([primaryTitle.trim().toLocaleLowerCase()]);
  const output: string[] = [];
  for (const title of splitAlternateTitles(alternateTitles)) {
    const normalized = title.toLocaleLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(title);
  }
  return output;
};

const mangaTagGroup = (manga: JsonRecord): { id: string; title: string; tags: Tag[] }[] => {
  const tags = genreRecords(firstDefined(manga, ["genres", "tags"])).map((genre) => ({
    id: tagId(genre),
    title: decodeHtmlText(genre.name),
  }));
  return tags.length > 0 ? [{ id: "genres", title: "Genres", tags }] : [];
};

const normalizedRating = (value: unknown): number | undefined => {
  const rating = asNumber(value);
  if (rating === undefined) return undefined;
  return Math.min(1, Math.max(0, rating > 1 ? rating / 10 : rating));
};

export const parseMangaList = (value: unknown): MangaListItem[] => {
  return extractMangaList(value).flatMap((manga) => {
    const slug = postSlug(manga);
    const title = decodeHtmlText(firstDefined(manga, ["postTitle", "title", "name", "post_title"]));
    if (!slug || !title) return [];

    const chapters = extractChapterList(manga);
    const latestChapter = [...chapters].sort(compareStable).at(-1);
    const latestChapterAccess = latestChapter ? chapterAccess(latestChapter) : undefined;
    const chapterLabel = latestChapter
      ? `${latestChapterAccess?.isAccessible === false ? "🔒 " : ""}Chapter ${chapterNumber(latestChapter)}`
      : undefined;
    const type = mapType(firstDefined(manga, ["seriesType", "type", "contentType", "series_type"]));
    const status = mapStatus(firstDefined(manga, ["seriesStatus", "status", "series_status"]));
    const subtitle = [chapterLabel, type === "novel" ? "Novel" : undefined, status]
      .filter((part): part is string => Boolean(part))
      .join(" • ");
    const publishDate =
      parseDate(
        firstDefined(manga, ["lastChapterAddedAt", "updatedAt", "createdAt", "releaseDate"]),
      ) ?? (latestChapter ? dateValue(latestChapter) : undefined);
    const firstChapter = latestChapter;

    return [
      {
        mangaId: encodeMangaId(slug, postId(manga)),
        title,
        imageUrl:
          safeUrl(
            firstDefined(manga, ["featuredImage", "cover", "coverUrl", "image", "featured_image"]),
          ) || "",
        subtitle: subtitle || undefined,
        contentRating: contentRatingForManga(manga),
        contentType: type,
        status,
        author: normalizeCreator(manga.author),
        artist: normalizeCreator(manga.artist),
        rating: normalizedRating(manga.averageRating),
        latestChapterId: firstChapter
          ? asText(firstDefined(firstChapter, ["id", "chapterId"]))
          : undefined,
        publishDate,
      },
    ];
  });
};

export const parseSearchResults = parseMangaList;

export const parseMangaDetails = (value: unknown, requestedMangaId?: string): SourceManga => {
  const manga = extractManga(value);
  const slug = postSlug(manga);
  if (!slug) throw new Error("Vortex Scans response did not contain a manga slug");

  const primaryTitle = decodeHtmlText(
    firstDefined(manga, ["postTitle", "title", "name", "post_title"]),
  );
  if (!primaryTitle) throw new Error("Vortex Scans response did not contain a manga title");

  const contentType = mapType(
    firstDefined(manga, ["seriesType", "type", "contentType", "series_type"]),
  );
  const status = mapStatus(firstDefined(manga, ["seriesStatus", "status", "series_status"]));
  const thumbnailUrl = safeUrl(
    firstDefined(manga, ["featuredImage", "cover", "coverUrl", "image", "featured_image"]),
  );
  const author = normalizeCreator(manga.author);
  const artist = normalizeCreator(manga.artist);
  const additionalInfo: Record<string, string> = { slug };
  const numericId = postId(manga);
  if (numericId) additionalInfo.id = numericId;

  const mangaId = mangaIdFor(manga, requestedMangaId);
  const shareUrl = safeUrl(`/series/${encodeURIComponent(slug)}`);
  const synopsis = stripHtml(
    asText(firstDefined(manga, ["postContent", "description", "synopsis", "post_content"])) ?? "",
  );
  const mangaInfo: MangaInfo = {
    primaryTitle,
    secondaryTitles: uniqueTitles(
      primaryTitle,
      firstDefined(manga, ["alternativeTitles", "altTitles", "alternative_titles"]),
    ),
    thumbnailUrl,
    synopsis,
    contentRating: contentRatingForManga(manga),
    contentType,
    status,
    author,
    artist,
    rating: normalizedRating(manga.averageRating),
    tagGroups: mangaTagGroup(manga),
    shareUrl,
    additionalInfo,
  };

  return { mangaId, mangaInfo };
};

export function chapterAccess(value: unknown): ChapterAccess {
  const chapter = asRecord(value);
  const unlockAt = parseDate(firstDefined(chapter, ["unlockAt", "freeAt", "availableAt"]));
  const timeLockedByDate = unlockAt !== undefined && unlockAt.getTime() > Date.now();
  const isTimeLocked =
    asBoolean(firstDefined(chapter, ["isTimeLocked"])) === true || timeLockedByDate;
  const isPermanentlyLocked =
    asBoolean(firstDefined(chapter, ["isPermanentlyLocked", "permanentlyLocked"])) === true;
  const isLockedByCoins =
    asBoolean(firstDefined(chapter, ["isLockedByCoins", "lockedByCoins"])) === true;
  const isShortLinkLocked =
    asBoolean(firstDefined(chapter, ["isShortLinkLocked", "shortLinkLocked"])) === true;

  const chapterPurchased =
    asBoolean(chapter.chapterPurchased) === true ||
    asBoolean(chapter.isPurchased) === true ||
    asBoolean(chapter.hasPurchased) === true;
  const isPurchased =
    chapterPurchased || asBoolean(firstDefined(chapter, ["isPurchased"])) === true;
  const hasPurchased =
    chapterPurchased || asBoolean(firstDefined(chapter, ["hasPurchased"])) === true;
  const price = Math.max(
    0,
    asNumber(firstDefined(chapter, ["finalPrice", "price", "chapterPrice"])) ?? 0,
  );
  const explicitLocked = asBoolean(firstDefined(chapter, ["isLocked", "locked"]));
  const isLocked =
    explicitLocked === true ||
    isTimeLocked ||
    isPermanentlyLocked ||
    isLockedByCoins ||
    isShortLinkLocked ||
    price > 0;
  const explicitAccessible = asBoolean(firstDefined(chapter, ["isAccessible", "accessible"]));
  const isAccessible =
    chapterPurchased ||
    explicitAccessible === true ||
    (explicitAccessible === undefined && !isLocked);

  return {
    isLocked,
    isTimeLocked,
    isPermanentlyLocked,
    isLockedByCoins,
    isShortLinkLocked,
    price,
    chapterPurchased,
    isPurchased,
    hasPurchased,
    isAccessible,
    unlockAt,
  };
}

const accessInfo = (chapter: JsonRecord, access: ChapterAccess): Record<string, string> => {
  const info: Record<string, string> = {
    isLocked: String(access.isLocked),
    isTimeLocked: String(access.isTimeLocked),
    isPermanentlyLocked: String(access.isPermanentlyLocked),
    isLockedByCoins: String(access.isLockedByCoins),
    isShortLinkLocked: String(access.isShortLinkLocked),
    price: String(access.price),
    chapterPurchased: String(access.chapterPurchased),
    isPurchased: String(access.isPurchased),
    hasPurchased: String(access.hasPurchased),
    isAccessible: String(access.isAccessible),
  };
  if (access.unlockAt) info.unlockAt = access.unlockAt.toISOString();
  const slug = asText(chapter.slug);
  if (slug) info.slug = slug;
  const post = asText(firstDefined(chapter, ["mangaPostId", "postId", "seriesId"]));
  if (post) info.mangaPostId = post;
  return info;
};

export const parseChapterList = (
  value: unknown,
  sourceManga: SourceManga,
  options: ParseChapterListOptions | boolean = {},
): Chapter[] => {
  const showLocked = typeof options === "boolean" ? options : (options.showLocked ?? true);
  const langCode = typeof options === "boolean" ? "en" : (options.langCode ?? "en");
  const chapters = extractChapterList(value)
    .filter((chapter) => {
      const status = asText(chapter.chapterStatus)?.toUpperCase();
      return !status || !["DRAFT", "PRIVATE", "TRASH", "PENDING"].includes(status);
    })
    .map((chapter, index) => ({ chapter, index, access: chapterAccess(chapter) }))
    .filter(({ access }) => showLocked || access.isAccessible);

  chapters.sort((left, right) => {
    const result = compareStable(left.chapter, right.chapter);
    return result !== 0 ? result : left.index - right.index;
  });

  return chapters.map(({ chapter, access }, sortingIndex) => {
    const chapterId = asText(firstDefined(chapter, ["id", "chapterId"]));
    if (!chapterId) throw new Error("Vortex Scans chapter did not contain an ID");
    const title = decodeHtmlText(chapter.title);
    const displayTitle =
      access.isLocked && !access.isAccessible
        ? `🔒 ${title || "Locked chapter"}${access.price > 0 ? ` — ${access.price} coins` : ""}`
        : title;
    const output: Chapter = {
      chapterId,
      sourceManga,
      langCode,
      chapNum: chapterNumber(chapter),
      volume: 0,
      sortingIndex,
      additionalInfo: accessInfo(chapter, access),
    };
    if (displayTitle) output.title = displayTitle;
    const publishDate = dateValue(chapter);
    if (publishDate) output.publishDate = publishDate;
    return output;
  });
};

export const parseChapters = parseChapterList;

const chapterContext = (chapter: unknown): { id?: string; mangaId?: string } => {
  const context = asRecord(chapter);
  const source = isRecord(context.sourceManga) ? context.sourceManga : undefined;
  const sourceInfo = source && isRecord(source.mangaInfo) ? source.mangaInfo : undefined;
  return {
    id: asText(firstDefined(context, ["chapterId", "id"])),
    mangaId:
      asText(firstDefined(context, ["mangaId"])) ??
      asText(source?.mangaId) ??
      asText(sourceInfo?.mangaId),
  };
};

const unwrapChapter = (value: unknown): JsonRecord => {
  if (!isRecord(value)) return {};
  if (isRecord(value.chapter)) return value.chapter;
  if (isRecord(value.data)) return value.data;
  return value;
};

const pageCandidate = (value: unknown): { url: string; order: number } | undefined => {
  if (typeof value === "string") return { url: value, order: Number.MAX_SAFE_INTEGER };
  if (!isRecord(value)) return undefined;
  const url = asText(firstDefined(value, ["url", "src", "imageUrl", "path", "image"]));
  if (!url) return undefined;
  return {
    url,
    order: asNumber(firstDefined(value, ["order", "index", "position"])) ?? Number.MAX_SAFE_INTEGER,
  };
};

const chapterPages = (chapter: JsonRecord): string[] => {
  const candidates: { url: string; order: number; inputIndex: number }[] = [];
  for (const key of ["pages", "images", "pageImages", "chapterPages"]) {
    for (const [inputIndex, value] of asArray(chapter[key]).entries()) {
      const page = pageCandidate(value);
      if (page) candidates.push({ ...page, inputIndex });
    }
  }
  candidates.sort((left, right) => left.order - right.order || left.inputIndex - right.inputIndex);
  return candidates.map((page) => safeUrl(page.url)).filter(Boolean);
};

const safeChapterHtml = (content: string): string => {
  const $ = load(content, null, false);
  $("script, style, iframe, object, embed, form, base, link, meta, svg, math").remove();
  $("*").each((_, element) => {
    const attributes =
      "attribs" in element && isRecord(element.attribs)
        ? (element.attribs as Record<string, unknown>)
        : {};
    for (const attribute of Object.keys(attributes)) {
      const normalizedAttribute = attribute.toLowerCase();
      if (
        /^on/i.test(attribute) ||
        ["style", "srcdoc", "srcset", "formaction"].includes(normalizedAttribute)
      ) {
        $(element).removeAttr(attribute);
        continue;
      }

      if (["href", "src", "poster", "xlink:href"].includes(normalizedAttribute)) {
        const rawValue = asText(attributes[attribute]);
        const safeValue = rawValue?.startsWith("#") ? rawValue : safeUrl(rawValue);
        if (safeValue) $(element).attr(attribute, safeValue);
        else $(element).removeAttr(attribute);
      }
    }
  });
  const body = $("body").length ? ($("body").html() ?? "") : ($.root().html() ?? "");
  return `<html xmlns="http://www.w3.org/1999/xhtml"><head></head><body>${body.trim()}</body></html>`;
};

const chapterHtmlDetails = (content: string, id: string, mangaId: string): ChapterDetails => ({
  type: "html",
  id,
  mangaId,
  html: safeChapterHtml(content),
});

const parseHtmlDocument = (
  html: string,
  id: string,
  mangaId: string,
): ChapterDetails | undefined => {
  const $ = load(html, null, false);
  let imageElements = $("[data-reader-page-image]").toArray();
  if (imageElements.length === 0) {
    imageElements = $(".comic-images-wrapper img, .comic-body-container img").toArray();
  }
  if (imageElements.length > 0) {
    const pages = imageElements
      .map((element, inputIndex) => ({
        url: safeUrl(
          element.attribs?.src ??
            element.attribs?.["data-src"] ??
            element.attribs?.["data-original"] ??
            element.attribs?.["data-lazy-src"],
        ),
        order: asNumber(element.attribs?.["data-reader-index"] ?? element.attribs?.["data-order"]),
        inputIndex,
      }))
      .filter((page) => Boolean(page.url))
      .sort(
        (left, right) =>
          (left.order ?? Number.MAX_SAFE_INTEGER) - (right.order ?? Number.MAX_SAFE_INTEGER) ||
          left.inputIndex - right.inputIndex,
      )
      .map((page) => page.url);
    if (pages.length > 0) return { id, mangaId, pages };
  }

  const articleBodies = $("[itemprop='articleBody']").toArray();
  const novelBody = articleBodies.find((element) => {
    const elementHtml = $(element).html() ?? "";
    return /<p\b/i.test(elementHtml) && !$(element).find("img").length;
  });
  if (novelBody) return chapterHtmlDetails($(novelBody).html() ?? "", id, mangaId);

  const bodyHtml = $("body").html();
  if (bodyHtml && !/<(?:nav|header|footer)\b/i.test(bodyHtml)) {
    return chapterHtmlDetails(bodyHtml, id, mangaId);
  }

  return undefined;
};

const contextMangaId = (rawChapter: JsonRecord, context: { mangaId?: string }): string => {
  if (context.mangaId) return context.mangaId;
  const mangaPost = isRecord(rawChapter.mangaPost) ? rawChapter.mangaPost : undefined;
  const slug = asText(mangaPost?.slug) ?? asText(rawChapter.seriesSlug);
  if (slug) return encodeMangaId(slug, asText(rawChapter.mangaPostId));
  return "unknown";
};

const chapterWithContextAccess = (rawChapter: JsonRecord, chapter: unknown): JsonRecord => {
  const context = asRecord(chapter);
  const additionalInfo = isRecord(context.additionalInfo) ? context.additionalInfo : {};
  return { ...additionalInfo, ...rawChapter };
};

export const parseChapterDetails = (value: unknown, chapter: unknown = {}): ChapterDetails => {
  const context = chapterContext(chapter);
  const rawChapter = unwrapChapter(value);
  const id = context.id ?? asText(firstDefined(rawChapter, ["id", "chapterId"]));
  if (!id) throw new Error("Vortex Scans chapter details did not contain an ID");
  const mangaId = contextMangaId(rawChapter, context);
  const contextAccess = chapterWithContextAccess(rawChapter, chapter);
  const access = chapterAccess(contextAccess);
  const explicitlyInaccessible = asBoolean(firstDefined(contextAccess, ["isAccessible"])) === false;
  if (!access.isAccessible && (access.isLocked || explicitlyInaccessible)) {
    throw new Error(
      "Chapter is locked. Unlock it on Vortex Scans, then log in from the extension settings.",
    );
  }

  if (typeof value === "string") {
    const parsedHtml = parseHtmlDocument(value, id, mangaId);
    if (parsedHtml) return parsedHtml;
    return chapterHtmlDetails(value, id, mangaId);
  }

  const html = asText(
    firstDefined(rawChapter, ["content", "html", "novelContent", "chapterContent"]),
  );
  if (html) {
    const parsedHtml = /data-reader-page-image|comic-images-wrapper/i.test(html)
      ? parseHtmlDocument(html, id, mangaId)
      : undefined;
    if (parsedHtml) return parsedHtml;
    return chapterHtmlDetails(html, id, mangaId);
  }

  const pages = chapterPages(rawChapter);
  if (pages.length > 0) return { id, mangaId, pages };
  if (access.isPurchased || access.chapterPurchased || access.hasPurchased) {
    throw new Error(
      "Vortex confirmed this chapter was purchased but returned no readable content. Please try again.",
    );
  }
  throw new Error("Vortex Scans chapter did not contain readable content.");
};

export const parseChapterData = parseChapterDetails;
