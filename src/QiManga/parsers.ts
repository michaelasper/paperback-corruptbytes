import {
  ContentRating,
  type Chapter,
  type ChapterDetails,
  type SourceManga,
  type Tag,
} from "@paperback/types";
import { load } from "cheerio";

import { contentRatingForTags, plainTextFromHtml, sanitizeChapterHtml } from "../shared/html.js";
import {
  decodePaperbackIdComponent,
  encodePaperbackIdComponent,
  validateOpaqueId,
} from "../shared/ids.js";
import { resolveHttpsUrl } from "../shared/url.js";
import type { QiMangaCard, QiSeriesItem } from "./models.js";
import {
  DOMAIN,
  isNeutralMediaUrl,
  isValidSeriesSlug,
  seriesIdToSlug,
  seriesSlugToId,
} from "./network.js";

const FALLBACK_COVER_URL = `${DOMAIN}/qiscans.ico`;
const MAX_CARDS = 200;
const MAX_CHAPTERS_PER_PAGE = 100;
const MAX_CHAPTER_IMAGES = 500;
const MAX_GENRES = 500;
const MAX_NOVEL_HTML_LENGTH = 2 * 1_024 * 1_024;
const MAX_NOVEL_READER_LENGTH = 4 * 1_024 * 1_024;
const SERIES_TYPES = new Set(["MANGA", "MANHWA", "MANHUA", "NOVEL"]);

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const boundedArray = (value: unknown, maximum: number, label: string): unknown[] => {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new Error(`Qi Manga returned an invalid ${label}.`);
  }
  return value;
};

const clean = (value: unknown, maximum = 16_384): string =>
  typeof value === "string" && value.length <= maximum
    ? value
        .replace(/\u00a0/g, " ")
        .replace(/\s+/g, " ")
        .trim()
    : "";

const finiteNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const nonNegativeInteger = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

const rating = (value: unknown): number | undefined => {
  const parsed = finiteNumber(value);
  return parsed === undefined ? undefined : Math.min(1, Math.max(0, parsed / 5));
};

export const parseDate = (value: unknown): Date | undefined => {
  if (typeof value !== "string" || value.length > 32) return undefined;
  const match = value.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?[zZ]$/);
  if (!match) return undefined;
  const canonical = `${match[1]}.${(match[2] ?? "").padEnd(3, "0")}Z`;
  const date = new Date(canonical);
  return !Number.isNaN(date.getTime()) && date.toISOString() === canonical ? date : undefined;
};

const statusLabel = (value: unknown): string | undefined => {
  const status = clean(value, 64).toUpperCase();
  switch (status) {
    case "ONGOING":
      return "Ongoing";
    case "COMPLETED":
      return "Completed";
    case "HIATUS":
      return "Hiatus";
    case "DROPPED":
      return "Dropped";
    case "CANCELLED":
      return "Cancelled";
    case "MASS_RELEASED":
      return "Mass released";
    default:
      return status || undefined;
  }
};

const seriesItem = (value: unknown): QiSeriesItem | undefined => {
  const record = asRecord(value);
  const slug = typeof record.slug === "string" ? record.slug : "";
  const title = clean(record.title, 1_024);
  const type = clean(record.type, 64).toUpperCase();
  if (
    !slug ||
    !title ||
    !isValidSeriesSlug(slug) ||
    !SERIES_TYPES.has(type) ||
    (record.redirectUrl != null && typeof record.redirectUrl !== "string")
  ) {
    return undefined;
  }
  return {
    slug,
    title,
    cover: typeof record.cover === "string" ? record.cover : null,
    type,
    status: typeof record.status === "string" ? record.status : null,
    avgRating: finiteNumber(record.avgRating),
    redirectUrl: typeof record.redirectUrl === "string" ? record.redirectUrl : null,
  };
};

const mediaUrl = (value: unknown): string | undefined => {
  const resolved = resolveHttpsUrl(value, DOMAIN);
  return resolved && isNeutralMediaUrl(resolved) ? resolved : undefined;
};

const hasExternalRedirect = (value: unknown): boolean =>
  value != null && (typeof value !== "string" || Boolean(value.trim()));

const cardFromItem = (item: QiSeriesItem): QiMangaCard | undefined => {
  if (hasExternalRedirect(item.redirectUrl)) return undefined;
  const imageUrl = mediaUrl(item.cover) ?? FALLBACK_COVER_URL;
  const parsedRating = rating(item.avgRating);
  return {
    mangaId: seriesSlugToId(item.slug),
    title: item.title,
    imageUrl,
    contentRating: ContentRating.ADULT,
    ...(parsedRating !== undefined && { rating: parsedRating }),
    ...(clean(item.status, 64) && { status: clean(item.status, 64).toUpperCase() }),
    ...(clean(item.type, 64) && { type: clean(item.type, 64).toUpperCase() }),
  };
};

export const parseSeriesCards = (value: unknown): QiMangaCard[] => {
  const candidates = boundedArray(value, MAX_CARDS, "series list");
  const seen = new Set<string>();
  return candidates.flatMap((candidate): QiMangaCard[] => {
    const item = seriesItem(candidate);
    const card = item && cardFromItem(item);
    if (!card || seen.has(card.mangaId)) return [];
    seen.add(card.mangaId);
    return [card];
  });
};

export interface QiMangaSeriesPage {
  items: QiMangaCard[];
  page: number;
  pageCount: number;
  totalCount?: number;
}

export const parseSeriesPage = (value: unknown): QiMangaSeriesPage => {
  const record = asRecord(value);
  const page = nonNegativeInteger(record.current);
  const pageCount = nonNegativeInteger(record.totalPages);
  const totalCount = nonNegativeInteger(record.totalItems);
  const data = boundedArray(record.data, MAX_CARDS, "series list");
  if (
    page === undefined ||
    page < 1 ||
    pageCount === undefined ||
    (pageCount === 0 && (page !== 1 || data.length > 0 || (totalCount ?? 0) > 0)) ||
    (pageCount > 0 && page > pageCount) ||
    (totalCount !== undefined && data.length > totalCount)
  ) {
    throw new Error("Qi Manga returned an invalid paginated series response.");
  }
  return {
    items: parseSeriesCards(data),
    page,
    pageCount,
    ...(totalCount !== undefined && { totalCount }),
  };
};

export interface QiMangaHome {
  banners: QiMangaCard[];
  popular: QiMangaCard[];
  newSeries: QiMangaCard[];
  pinned: QiMangaCard[];
  editorsPick: QiMangaCard[];
}

export const parseHome = (value: unknown): QiMangaHome => {
  const record = asRecord(value);
  return {
    banners: parseSeriesCards(record.banners),
    popular: parseSeriesCards(record.popular),
    newSeries: parseSeriesCards(record.newSeries),
    pinned: parseSeriesCards(record.pinned),
    editorsPick: parseSeriesCards(record.editorsPick),
  };
};

const titleKey = (value: string): string =>
  value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const secondaryTitles = (value: unknown, primaryTitle: string): string[] => {
  const seen = new Set([titleKey(primaryTitle)]);
  const titles: string[] = [];
  for (const title of clean(value, 32_768).split(/\s*(?:,|;|\||•|\n|\r)\s*/)) {
    const normalized = title.trim();
    const key = titleKey(normalized);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    titles.push(normalized);
    if (titles.length >= 100) break;
  }
  return titles;
};

const person = (value: unknown): string | undefined => {
  const name = clean(value, 1_024);
  return !name || /^(?:unknown|n\/?a|updating)$/i.test(name) ? undefined : name;
};

export const parseMangaDetails = (value: unknown, mangaId: string): SourceManga => {
  const record = asRecord(value);
  const slug = typeof record.slug === "string" ? record.slug : "";
  const primaryTitle = clean(record.title, 1_024);
  if (!slug || !isValidSeriesSlug(slug) || !primaryTitle) {
    throw new Error("Qi Manga returned an invalid series detail response.");
  }
  if (decodePaperbackIdComponent(mangaId) !== slug) {
    throw new Error("Qi Manga returned details for a different series.");
  }
  if (hasExternalRedirect(record.redirectUrl)) {
    throw new Error("This Qi Manga title redirects to another website and is not available here.");
  }

  const genres = boundedArray(record.genres ?? [], MAX_GENRES, "series genre list")
    .flatMap((candidate): Tag[] => {
      const genre = asRecord(candidate);
      const id = typeof genre.slug === "string" ? genre.slug : "";
      const title = clean(genre.name, 256);
      return id && title && isValidSeriesSlug(id) ? [{ id, title }] : [];
    })
    .filter(
      (genre, index, items) => items.findIndex((candidate) => candidate.id === genre.id) === index,
    );
  const genreNames = genres.map((genre) => genre.title);
  const stats = asRecord(record.stats);
  const parsedRating = rating(stats.averageRating ?? record.avgRating);
  const chapterCount = nonNegativeInteger(stats.chapterCount);
  const type = clean(record.type, 64).toUpperCase();
  if (!SERIES_TYPES.has(type)) {
    throw new Error("Qi Manga returned an invalid series detail response.");
  }
  const author = person(record.author);
  const artist = person(record.artist);
  const additionalInfo: Record<string, string> = {};
  if (type)
    additionalInfo.Format = type === "NOVEL" ? "Novel" : type[0] + type.slice(1).toLowerCase();
  if (chapterCount !== undefined) additionalInfo.Chapters = String(chapterCount);

  return {
    mangaId,
    mangaInfo: {
      primaryTitle,
      secondaryTitles: secondaryTitles(record.alternativeTitles, primaryTitle),
      thumbnailUrl: mediaUrl(record.cover) ?? FALLBACK_COVER_URL,
      synopsis: plainTextFromHtml(
        typeof record.description === "string" && record.description.length <= 1_024 * 1_024
          ? record.description
          : "",
      ),
      contentRating: contentRatingForTags(genreNames),
      contentType: type === "NOVEL" ? "novel" : "comic",
      ...(statusLabel(record.status) && { status: statusLabel(record.status) }),
      ...(author && { author }),
      ...(artist && { artist }),
      ...(parsedRating !== undefined && { rating: parsedRating }),
      ...(genres.length > 0 && {
        tagGroups: [{ id: "genres", title: "Genres", tags: genres }],
      }),
      ...(Object.keys(additionalInfo).length > 0 && { additionalInfo }),
      shareUrl: `${DOMAIN}/series/${encodePaperbackIdComponent(slug)}`,
    },
  };
};

export interface QiMangaChapterPage {
  chapters: Chapter[];
  page: number;
  pageCount: number;
  totalCount?: number;
}

const chapterTitle = (
  record: Record<string, unknown>,
  locked: boolean,
  price: number | undefined,
): string | undefined => {
  const actualTitle = clean(record.title, 1_024) || undefined;
  if (!locked) return actualTitle;
  const lock =
    price !== undefined
      ? `🔒 ${Number(price.toFixed(2))} coin${price === 1 ? "" : "s"}`
      : "🔒 Locked";
  return actualTitle ? `${lock} • ${actualTitle}` : lock;
};

export const parseChapterPage = (
  value: unknown,
  sourceManga: SourceManga,
  showLocked: boolean,
): QiMangaChapterPage => {
  const record = asRecord(value);
  const page = nonNegativeInteger(record.current);
  const pageCount = nonNegativeInteger(record.totalPages);
  const totalCount = nonNegativeInteger(record.totalItems);
  const data = boundedArray(record.data, MAX_CHAPTERS_PER_PAGE, "chapter list");
  if (
    page === undefined ||
    page < 1 ||
    pageCount === undefined ||
    (pageCount === 0 && (page !== 1 || data.length > 0 || (totalCount ?? 0) > 0)) ||
    (pageCount > 0 && page > pageCount) ||
    (totalCount !== undefined && data.length > totalCount)
  ) {
    throw new Error("Qi Manga returned an invalid paginated chapter response.");
  }
  const chapters = data.flatMap((candidate): Chapter[] => {
    const chapter = asRecord(candidate);
    const slug = validateOpaqueId(chapter.slug, 256);
    const chapterId = slug && encodePaperbackIdComponent(slug);
    const chapNum = finiteNumber(chapter.number);
    if (!slug || !chapterId || chapterId.length > 256 || chapNum === undefined || chapNum < 0) {
      return [];
    }
    // `isFree` is static pricing metadata. `requiresPurchase` is the account-specific
    // access decision returned by Qi Manga, including for already-owned paid chapters.
    const locked = chapter.requiresPurchase !== false;
    if (locked && !showLocked) return [];
    const rawPrice = finiteNumber(chapter.discountedPrice ?? chapter.price);
    const price = rawPrice !== undefined && rawPrice >= 0 ? rawPrice : undefined;
    const title = chapterTitle(chapter, locked, price);
    const publishDate = parseDate(chapter.createdAt);
    const additionalInfo: Record<string, string> = { locked: String(locked) };
    if (price !== undefined) additionalInfo.price = String(price);
    return [
      {
        chapterId,
        sourceManga,
        langCode: "en",
        chapNum,
        ...(title && { title }),
        additionalInfo,
        ...(publishDate && { publishDate }),
      },
    ];
  });
  return {
    chapters,
    page,
    pageCount,
    ...(totalCount !== undefined && { totalCount }),
  };
};

export const finalizeChapters = (chapters: Chapter[]): Chapter[] => {
  const seen = new Set<string>();
  return chapters
    .filter((chapter) => {
      if (seen.has(chapter.chapterId)) return false;
      seen.add(chapter.chapterId);
      return true;
    })
    .sort((left, right) => {
      const numberDifference = left.chapNum - right.chapNum;
      if (numberDifference !== 0) return numberDifference;
      const dateDifference =
        (left.publishDate?.getTime() ?? 0) - (right.publishDate?.getTime() ?? 0);
      return dateDifference || compareText(left.chapterId, right.chapterId);
    })
    .map((chapter, sortingIndex) => ({ ...chapter, sortingIndex }));
};

const LOCKED_ERROR =
  "This chapter is still locked on Qi Manga. Purchase it on the Qi Manga website before trying again.";

export const parseChapterDetails = (value: unknown, chapter: Chapter): ChapterDetails => {
  const record = asRecord(value);
  const returnedSlug = validateOpaqueId(record.slug, 256);
  const expectedSlug = validateOpaqueId(decodePaperbackIdComponent(chapter.chapterId));
  if (!returnedSlug || !expectedSlug || returnedSlug !== expectedSlug) {
    throw new Error("Qi Manga returned content for a different chapter.");
  }

  const seriesSlug = asRecord(record.series).slug;
  const returnedSeriesSlug = typeof seriesSlug === "string" ? seriesSlug : "";
  if (
    !isValidSeriesSlug(returnedSeriesSlug) ||
    returnedSeriesSlug !== seriesIdToSlug(chapter.sourceManga.mangaId)
  ) {
    throw new Error("Qi Manga returned content for a different series.");
  }

  // Fail closed unless the server explicitly grants this session access. Paid chapters
  // remain `isFree: false` after purchase, so that field must never override the grant.
  if (record.requiresPurchase !== false || record.requiresAuth === true) {
    throw new Error(LOCKED_ERROR);
  }

  const rawContent =
    typeof record.content === "string" && record.content.length <= MAX_NOVEL_HTML_LENGTH
      ? record.content.trim()
      : "";
  let sanitizedContent = rawContent ? sanitizeChapterHtml(rawContent, DOMAIN) : undefined;
  if (sanitizedContent && sanitizedContent.length <= MAX_NOVEL_READER_LENGTH) {
    const $ = load(sanitizedContent);
    $("img[src]").each((_, element) => {
      const source = $(element).attr("src");
      if (!source || !isNeutralMediaUrl(source)) $(element).remove();
    });
    sanitizedContent = $.html();
  } else {
    sanitizedContent = undefined;
  }
  const readableContent =
    sanitizedContent &&
    sanitizedContent.length <= MAX_NOVEL_READER_LENGTH &&
    plainTextFromHtml(sanitizedContent).trim()
      ? sanitizedContent
      : undefined;
  if (chapter.sourceManga.mangaInfo.contentType === "novel" && readableContent) {
    return {
      id: chapter.chapterId,
      mangaId: chapter.sourceManga.mangaId,
      type: "html",
      html: readableContent,
    };
  }

  const images = boundedArray(record.images ?? [], MAX_CHAPTER_IMAGES, "chapter image list")
    .flatMap((candidate, inputIndex) => {
      const image = asRecord(candidate);
      const url = mediaUrl(image.url);
      if (!url) return [];
      return [{ url, order: finiteNumber(image.order) ?? inputIndex, inputIndex }];
    })
    .sort((left, right) => left.order - right.order || left.inputIndex - right.inputIndex);
  const seen = new Set<string>();
  const pages = images.flatMap(({ url }): string[] => {
    if (seen.has(url)) return [];
    seen.add(url);
    return [url];
  });
  if (pages.length > 0) {
    return { id: chapter.chapterId, mangaId: chapter.sourceManga.mangaId, pages };
  }
  if (readableContent) {
    return {
      id: chapter.chapterId,
      mangaId: chapter.sourceManga.mangaId,
      type: "html",
      html: readableContent,
    };
  }
  throw new Error("Qi Manga returned no readable pages or novel text for this chapter.");
};

export const parseGenres = (value: unknown): Tag[] => {
  const seen = new Set<string>();
  return boundedArray(value, MAX_GENRES, "genre list")
    .flatMap((candidate): Tag[] => {
      const record = asRecord(candidate);
      const id = typeof record.slug === "string" ? record.slug : "";
      const title = clean(record.name, 256);
      if (!id || !title || !isValidSeriesSlug(id) || seen.has(id)) return [];
      seen.add(id);
      return [{ id, title }];
    })
    .sort((left, right) => compareText(left.title, right.title));
};

export { FALLBACK_COVER_URL, LOCKED_ERROR };
