import {
  ContentRating,
  URL as PaperbackURL,
  type Chapter,
  type ChapterDetails,
  type SourceManga,
  type Tag,
} from "@paperback/types";
import { load } from "cheerio";

import { contentRatingForTags, plainTextFromHtml, sanitizeChapterHtml } from "./html.js";
import { decodePaperbackIdComponent, encodePaperbackIdComponent, validateOpaqueId } from "./ids.js";
import {
  extractNovelDashArrays,
  extractNovelDashObject,
  parseNovelDashFlight,
  resolveNovelDashFlightString,
  type NovelDashFlightDocument,
} from "./noveldash-flight.js";
import type {
  NovelDashCatalogChapter,
  NovelDashCatalogResponse,
  NovelDashCatalogSeries,
  NovelDashReaderData,
  NovelDashReaderPage,
  NovelDashRouteKind,
  NovelDashSeriesChapter,
  NovelDashSeriesData,
  NovelDashSeriesPage,
  NovelDashSite,
  NovelDashTaxonomyItem,
} from "./noveldash-models.js";
import {
  decodeNovelDashMangaId,
  encodeNovelDashMangaId,
  routeKindForSeriesType,
} from "./noveldash-network.js";
import { isHttpsUrlForHosts, resolveHttpsUrl } from "./url.js";

export interface NovelDashCatalogItem {
  mangaId: string;
  title: string;
  imageUrl: string;
  contentRating: ContentRating;
  type?: string;
  status?: string;
  rating?: number;
  isHot: boolean;
  genres: string[];
  latestChapterId?: string;
  latestChapterNumber?: number;
  latestChapterTitle?: string;
  latestPublishDate?: Date;
}

export interface ParsedNovelDashCatalog {
  items: NovelDashCatalogItem[];
  total: number;
  page: number;
  totalPages: number;
  hasMore: boolean;
}

export interface ParsedNovelDashSeriesPage {
  sourceManga: SourceManga;
  chapters: Chapter[];
  currentPage: number;
  totalPages: number;
  declaredChapterCount?: number;
  seriesId?: string;
}

const FALLBACK_MAX_CHAPTER_PAGES = 1_000;
const mediaHostsBySite = new WeakMap<NovelDashSite, ReadonlySet<string>>();

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const boolean = (value: unknown): boolean | undefined =>
  typeof value === "boolean" ? value : undefined;

const number = (value: unknown): number | undefined => {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const integer = (value: unknown): number | undefined => {
  const parsed = number(value);
  return parsed === undefined || !Number.isSafeInteger(parsed) ? undefined : parsed;
};

const date = (value: unknown): Date | undefined => {
  if (value instanceof Date) {
    const copy = new Date(value.getTime());
    return Number.isNaN(copy.getTime()) ? undefined : copy;
  }
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
};

const uniqueStrings = (values: readonly unknown[]): string[] => {
  const seen = new Set<string>();
  return values.flatMap((value): string[] => {
    const normalized = text(value);
    const key = normalized?.toLocaleLowerCase();
    if (!normalized || !key || seen.has(key)) return [];
    seen.add(key);
    return [normalized];
  });
};

const titleCase = (value: string): string =>
  value
    .toLocaleLowerCase()
    .split("_")
    .map((part) => (part ? `${part[0]!.toLocaleUpperCase()}${part.slice(1)}` : ""))
    .join(" ");

const routeKind = (value: unknown, fallback: NovelDashRouteKind): NovelDashRouteKind =>
  text(value) ? routeKindForSeriesType(value) : fallback;

const mediaHostsFor = (site: NovelDashSite): ReadonlySet<string> => {
  const cached = mediaHostsBySite.get(site);
  if (cached) return cached;
  const hosts = new Set([site.host, `www.${site.host}`, site.mediaHost]);
  mediaHostsBySite.set(site, hosts);
  return hosts;
};

const mediaUrl = (site: NovelDashSite, value: unknown): string | undefined => {
  const raw = text(value);
  if (!raw) return undefined;
  let candidate = raw;
  if (raw.includes("/_next/image")) {
    const nextImage = resolveHttpsUrl(raw, site.domain);
    try {
      const parsed = nextImage ? new PaperbackURL(nextImage) : undefined;
      const queryValue = parsed?.queryItems?.url;
      const wrapped = Array.isArray(queryValue) ? queryValue[0] : queryValue;
      if (parsed?.path === "/_next/image" && wrapped) candidate = wrapped;
    } catch {
      // The shared resolver below remains authoritative for malformed wrappers.
    }
  }

  const resolved = resolveHttpsUrl(candidate, site.domain);
  if (!resolved) return undefined;
  return isHttpsUrlForHosts(resolved, mediaHostsFor(site)) ? resolved : undefined;
};

export const normalizeNovelDashMediaUrl = mediaUrl;

const genreSlugs = (series: NovelDashCatalogSeries): string[] =>
  uniqueStrings((series.genres ?? []).map((entry) => entry.genre?.slug));

const contentRating = (
  genres: readonly string[],
  mature: unknown,
  tags: readonly string[] = [],
): ContentRating => {
  const derived = contentRatingForTags([...genres, ...tags]);
  return mature === true && derived === ContentRating.EVERYONE ? ContentRating.MATURE : derived;
};

const normalizedRating = (value: unknown): number | undefined => {
  const rating = number(value);
  return rating === undefined ? undefined : Math.max(0, Math.min(1, rating / 10));
};

const readableCatalogChapter = (
  chapters: readonly NovelDashCatalogChapter[],
): NovelDashCatalogChapter | undefined =>
  chapters.find(
    (chapter) => boolean(chapter.isFree) === true || boolean(chapter.isLocked) === false,
  );

export const parseNovelDashCatalog = (
  value: unknown,
  site: NovelDashSite,
): ParsedNovelDashCatalog => {
  const response = (record(value) ?? {}) as NovelDashCatalogResponse;
  const meta = record(response.meta) ?? {};
  const page = Math.max(1, integer(meta.page) ?? 1);
  const total = Math.max(0, integer(meta.total) ?? 0);
  const totalPages = Math.max(0, integer(meta.totalPages) ?? 0);
  const items = (Array.isArray(response.data) ? response.data : []).flatMap(
    (series): NovelDashCatalogItem[] => {
      if (!record(series) || boolean(series.dmcaTakenDown) === true) return [];
      const title = text(series.title);
      // `urlSlug` is the public route. Novel records often keep a distinct internal `slug`
      // (commonly with a `-novel` suffix) whose page silently renders no series data.
      const slug = text(series.urlSlug) ?? text(series.slug);
      const imageUrl = mediaUrl(site, series.coverImage) ?? `${site.domain}/favicon.png`;
      if (!title || !slug) return [];
      let mangaId: string;
      try {
        mangaId = encodeNovelDashMangaId(routeKindForSeriesType(series.type), slug);
      } catch {
        return [];
      }

      const genres = genreSlugs(series);
      const chapters = Array.isArray(series.chapters) ? series.chapters : [];
      const latest = readableCatalogChapter(chapters);
      const latestChapterId = validateOpaqueId(latest?.id);
      const latestChapterNumber = number(latest?.number);
      const latestChapterTitle = text(latest?.title);
      const latestPublishDate = date(latest?.publishedAt ?? latest?.createdAt);
      const type = text(series.type);
      const status = text(series.status);
      const rating = normalizedRating(series.rating);
      return [
        {
          mangaId,
          title,
          imageUrl,
          contentRating: contentRating(genres, series.isMature),
          isHot: boolean(series.isHot) === true,
          genres,
          ...(type && { type: titleCase(type) }),
          ...(status && { status: titleCase(status) }),
          ...(rating !== undefined && { rating }),
          ...(latestChapterId && { latestChapterId: encodePaperbackIdComponent(latestChapterId) }),
          ...(latestChapterNumber !== undefined && { latestChapterNumber }),
          ...(latestChapterTitle && { latestChapterTitle }),
          ...(latestPublishDate && { latestPublishDate }),
        },
      ];
    },
  );

  if (total > 0 && !Array.isArray(response.data)) {
    throw new Error(`${site.name} returned an invalid catalog response.`);
  }
  return {
    items,
    total,
    page,
    totalPages,
    hasMore:
      boolean(meta.hasMore) ??
      (totalPages > 0 ? page < totalPages : items.length > 0 && page * items.length < total),
  };
};

interface BookMetadata {
  author?: string;
  description?: string;
}

const bookMetadata = (html: string): BookMetadata => {
  const $ = load(html);
  for (const element of $("script[type='application/ld+json']").toArray()) {
    try {
      const value = JSON.parse($(element).text()) as unknown;
      const metadata = record(value);
      if (text(metadata?.["@type"]) !== "Book") continue;
      const authorValue = metadata?.author;
      const authorRecord = record(authorValue);
      const author = text(authorRecord?.name) ?? text(authorValue);
      const description = text(metadata?.description);
      return { ...(author && { author }), ...(description && { description }) };
    } catch {
      // Ignore unrelated or malformed structured-data blocks.
    }
  }
  return {};
};

const taxonomyTags = (value: unknown): Tag[] => {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const tags: Tag[] = [];
  for (const entry of value) {
    const outer = record(entry);
    const item = record(outer?.genre) ?? outer;
    const rawId = validateOpaqueId(item?.slug) ?? validateOpaqueId(item?.id);
    const title = text(item?.name) ?? text(item?.slug);
    if (!rawId || !title) continue;
    const id = encodePaperbackIdComponent(rawId);
    if (seen.has(id)) continue;
    seen.add(id);
    tags.push({ id, title });
  }
  return tags;
};

const secondaryTitles = (series: NovelDashSeriesData, primaryTitle: string): string[] => {
  const aliases = Array.isArray(series.aliases) ? series.aliases : [];
  const values = uniqueStrings([series.altTitle, series.originalTitle, ...aliases]);
  const primaryKey = primaryTitle.toLocaleLowerCase();
  return values.filter((value) => value.toLocaleLowerCase() !== primaryKey);
};

const sourceMangaFrom = (
  html: string,
  document: NovelDashFlightDocument,
  page: NovelDashSeriesPage,
  site: NovelDashSite,
  requestedMangaId: string,
): SourceManga => {
  const series = page.series;
  if (!series) throw new Error(`${site.name} did not return series details.`);
  const primaryTitle = text(series.title);
  if (!primaryTitle) throw new Error(`${site.name} did not return a series title.`);
  const decodedId = decodeNovelDashMangaId(requestedMangaId);
  const kind = routeKind(series.type, decodedId.kind);
  const genres = taxonomyTags(series.genres);
  const tags = taxonomyTags(series.tags);
  const genreTitles = genres.map((genre) => genre.title);
  const tagTitles = tags.map((tag) => tag.title);
  const schema = bookMetadata(html);
  const description =
    resolveNovelDashFlightString(series.description, document) ?? schema.description ?? "";
  const thumbnailUrl = mediaUrl(site, series.coverImage) ?? `${site.domain}/favicon.png`;
  const bannerUrl = mediaUrl(site, series.bannerImage);
  const status = text(series.status);
  const author = schema.author && !/^unknown$/i.test(schema.author) ? schema.author : undefined;
  const rating = normalizedRating(series.rating);
  const upstreamId = validateOpaqueId(series.id);
  const internalSlug = text(series.slug);
  const type = text(series.type);
  const origin = text(series.origin);
  const team = text(record(series.team)?.name);
  const declaredChapterCount = integer(series.chapterCount);
  const additionalInfo: Record<string, string> = {
    routeKind: decodedId.kind,
    routeSlug: decodedId.slug,
    ...(internalSlug && { internalSlug }),
    ...(upstreamId && { id: upstreamId }),
    ...(type && { type }),
    ...(origin && { origin }),
    ...(team && { team }),
    ...(declaredChapterCount !== undefined && { chapterCount: String(declaredChapterCount) }),
  };

  return {
    mangaId: requestedMangaId,
    mangaInfo: {
      primaryTitle,
      secondaryTitles: secondaryTitles(series, primaryTitle),
      thumbnailUrl,
      synopsis: plainTextFromHtml(description),
      contentRating: contentRating(genreTitles, series.isMature, tagTitles),
      contentType: kind === "comic" ? "comic" : "novel",
      ...(status && { status: titleCase(status) }),
      ...(author && { author }),
      ...(rating !== undefined && { rating }),
      ...(bannerUrl && { bannerUrl }),
      ...(genres.length > 0 || tags.length > 0
        ? {
            tagGroups: [
              ...(genres.length > 0
                ? [
                    {
                      id: "genres",
                      title: "Genres",
                      tags: genres,
                    },
                  ]
                : []),
              ...(tags.length > 0
                ? [
                    {
                      id: "tags",
                      title: "Tags",
                      tags,
                    },
                  ]
                : []),
            ],
          }
        : {}),
      shareUrl: `${site.domain}/series/${decodedId.kind}/${encodeURIComponent(decodedId.slug)}`,
      additionalInfo,
    },
  };
};

const chapterNumberText = (value: unknown): string | undefined => {
  const parsed = number(value);
  if (parsed === undefined || parsed < 0) return undefined;
  return typeof value === "string" && value.trim() ? value.trim() : String(parsed);
};

const chapterFrom = (
  value: NovelDashSeriesChapter,
  sourceManga: SourceManga,
  showLocked: boolean,
): Chapter | undefined => {
  const upstreamId = validateOpaqueId(value.id);
  const rawNumber = chapterNumberText(value.number);
  const chapNum = number(value.number);
  if (!upstreamId || !rawNumber || chapNum === undefined) return undefined;
  const isLocked = boolean(value.isLocked) === true;
  const explicitAccess = boolean(value.hasAccess);
  const isAccessible = explicitAccess === true || (explicitAccess === undefined && !isLocked);
  if (!showLocked && !isAccessible) return undefined;
  const coinPrice = Math.max(0, number(value.coinPrice) ?? 0);
  const rawTitle = text(value.title);
  const lockedLabel = `🔒 Locked${coinPrice > 0 ? ` — ${coinPrice} coins` : ""}`;
  const title = !isAccessible
    ? rawTitle
      ? `${lockedLabel} • ${rawTitle}`
      : lockedLabel
    : rawTitle;
  const publishDate = date(value.publishedAt);
  const format = text(value.contentFormat)?.toUpperCase();
  return {
    chapterId: encodePaperbackIdComponent(upstreamId),
    sourceManga,
    langCode: "en",
    chapNum,
    volume: 0,
    ...(title && { title }),
    ...(publishDate && { publishDate }),
    additionalInfo: {
      upstreamId,
      number: rawNumber,
      isLocked: String(isLocked),
      isAccessible: String(isAccessible),
      coinPrice: String(coinPrice),
      ...(format && { format }),
    },
  };
};

export const parseNovelDashSeriesPage = (
  html: string,
  site: NovelDashSite,
  requestedMangaId: string,
  options: { showLocked?: boolean; sourceManga?: SourceManga } = {},
): ParsedNovelDashSeriesPage => {
  const document = parseNovelDashFlight(html);
  const page = extractNovelDashObject<NovelDashSeriesPage>(document, '{"series":{');
  const sourceManga =
    options.sourceManga ?? sourceMangaFrom(html, document, page, site, requestedMangaId);
  const chapters = (Array.isArray(page.chapters) ? page.chapters : []).flatMap(
    (chapter): Chapter[] => {
      const parsed = chapterFrom(chapter, sourceManga, options.showLocked ?? true);
      return parsed ? [parsed] : [];
    },
  );
  const currentPage = Math.max(1, integer(page.currentPage) ?? 1);
  const totalPages = Math.max(1, integer(page.totalPages) ?? 1);
  if (totalPages > FALLBACK_MAX_CHAPTER_PAGES) {
    throw new Error(`${site.name} returned too many chapter pages to process safely.`);
  }
  return {
    sourceManga,
    chapters,
    currentPage,
    totalPages,
    declaredChapterCount: integer(page.series?.chapterCount),
    seriesId: validateOpaqueId(page.series?.id),
  };
};

const hasValues = (value: unknown): boolean => Array.isArray(value) && value.length > 0;

const protectedReaderPage = (
  page: NovelDashReaderPage,
  protection: NovelDashReaderData["protectionConfig"],
  hasDirectImage: boolean,
): boolean => {
  const isProtected = boolean(protection?.isProtected) === true;
  const hasTiles = boolean(page.isEncrypted) === true && hasValues(page.tiles);
  const hasStrips = boolean(page.hasStrips) === true && hasValues(page.strips);
  const hasFragments = boolean(page.hasFragments) === true && hasValues(page.fragments);
  const usesFragments =
    hasFragments &&
    ((isProtected && boolean(protection?.useFragmentProtection) === true) ||
      (!hasDirectImage && !hasTiles && !hasStrips));
  const usesTiles =
    hasTiles &&
    ((isProtected && boolean(protection?.useTileEncryption) === true) ||
      (!hasDirectImage && !hasStrips));
  const usesStrips = hasStrips && (isProtected || !hasDirectImage);
  const scramblesDirectImage =
    hasDirectImage &&
    isProtected &&
    (boolean(protection?.useImageScramble) === true ||
      boolean(protection?.useCanvasRendering) === true);
  return usesFragments || usesTiles || usesStrips || scramblesDirectImage;
};

const readerPages = (
  pages: readonly NovelDashReaderPage[],
  site: NovelDashSite,
  protection: NovelDashReaderData["protectionConfig"],
): string[] => {
  const resolved = pages.map((page) => ({ page, url: mediaUrl(site, page.imageUrl) }));
  if (resolved.some(({ page, url }) => protectedReaderPage(page, protection, Boolean(url)))) {
    throw new Error(`${site.name} returned a protected page layout that Paperback cannot render.`);
  }
  const seen = new Set<string>();
  return resolved
    .sort(
      (left, right) => (number(left.page.pageNumber) ?? 0) - (number(right.page.pageNumber) ?? 0),
    )
    .flatMap(({ url }): string[] => {
      if (!url || seen.has(url)) return [];
      seen.add(url);
      return [url];
    });
};

const lockedChapterError = (site: NovelDashSite, coinPrice: number): Error =>
  new Error(
    `This chapter is locked on ${site.name}${coinPrice > 0 ? ` for ${coinPrice} coins` : ""}. ` +
      `Unlock it on ${site.name}, then sign in from the extension settings.`,
  );

export const parseNovelDashChapterDetails = (
  html: string,
  chapter: Chapter,
  site: NovelDashSite,
): ChapterDetails => {
  const document = parseNovelDashFlight(html);
  const data = extractNovelDashObject<NovelDashReaderData>(document, '{"chapter":{');
  const responseId = validateOpaqueId(data.chapter?.id);
  const expectedId =
    validateOpaqueId(chapter.additionalInfo?.upstreamId) ??
    validateOpaqueId(decodePaperbackIdComponent(chapter.chapterId));
  if (!responseId || !expectedId || responseId !== expectedId) {
    throw new Error(`${site.name} returned a different chapter than requested.`);
  }
  const coinPrice = Math.max(
    0,
    number(data.chapter?.coinPrice ?? data.coinPrice ?? chapter.additionalInfo?.coinPrice) ?? 0,
  );
  const explicitlyUnlocked = boolean(data.isUnlocked) === true;
  const isLocked =
    !explicitlyUnlocked &&
    (boolean(data.isUnlocked) === false ||
      boolean(data.isLocked) === true ||
      boolean(data.chapter?.isLocked) === true ||
      chapter.additionalInfo?.isLocked === "true" ||
      chapter.additionalInfo?.isAccessible === "false");
  if (isLocked) throw lockedChapterError(site, coinPrice);

  const pages = readerPages(
    Array.isArray(data.chapter?.pages) ? data.chapter.pages : [],
    site,
    data.protectionConfig,
  );
  if (pages.length > 0) {
    return { id: chapter.chapterId, mangaId: chapter.sourceManga.mangaId, pages };
  }

  const rawContent = resolveNovelDashFlightString(data.chapter?.content, document);
  if (rawContent?.trim()) {
    const htmlContent = sanitizeChapterHtml(rawContent, site.domain);
    if (plainTextFromHtml(htmlContent).length > 0) {
      return {
        id: chapter.chapterId,
        mangaId: chapter.sourceManga.mangaId,
        type: "html",
        html: htmlContent,
      };
    }
  }
  throw new Error(`${site.name} returned no readable content for this chapter.`);
};

export const parseNovelDashGenres = (html: string, site: NovelDashSite): Tag[] => {
  const document = parseNovelDashFlight(html);
  const candidates = extractNovelDashArrays<NovelDashTaxonomyItem>(document, "genres")
    .map((items) =>
      items.flatMap((item): Tag[] => {
        const slug = validateOpaqueId(item.slug);
        const name = text(item.name);
        return slug && name ? [{ id: slug, title: name }] : [];
      }),
    )
    .filter((items) => items.length > 0)
    .sort((left, right) => right.length - left.length);
  const genres = candidates[0] ?? [];
  if (genres.length === 0) throw new Error(`${site.name} did not return its genre taxonomy.`);
  return [...new Map(genres.map((genre) => [genre.id, genre])).values()].sort((left, right) =>
    left.title.localeCompare(right.title),
  );
};
