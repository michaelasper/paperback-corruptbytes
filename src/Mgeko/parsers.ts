import {
  ContentRating,
  type Chapter,
  type ChapterDetails,
  type SourceManga,
  type Tag,
} from "@paperback/types";
import { load, type CheerioAPI } from "cheerio";

import { contentRatingForTags, plainTextFromHtml } from "../shared/html.js";
import { decodePaperbackIdComponent, encodePaperbackIdComponent } from "../shared/ids.js";
import { resolveHttpsUrl } from "../shared/url.js";
import type { MgekoBrowseEnvelope, MgekoCard, MgekoFilterOptions } from "./models.js";
import { DOMAIN } from "./network.js";

const FALLBACK_COVER_URL = `${DOMAIN}/favicon.ico`;
const PLACEHOLDER_IMAGE = /(?:credits-mgeko|default-placeholder|placeholder\.gif|loading)[^/]*$/i;

const clean = (value: string | null | undefined): string =>
  (value ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const finiteNumber = (value: unknown): number | undefined => {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const match = value.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  if (!match) return undefined;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : undefined;
};

export const parseBrowseResponse = (value: unknown): MgekoBrowseEnvelope => {
  const record = asRecord(value);
  const resultsHtml = typeof record.results_html === "string" ? record.results_html : undefined;
  const page = finiteNumber(record.page);
  const pageCount = finiteNumber(record.num_pages);
  const totalCount = finiteNumber(record.total_results);
  if (!resultsHtml || page === undefined || pageCount === undefined) {
    throw new Error("Mgeko returned an invalid browse response.");
  }
  return {
    resultsHtml,
    page: Math.max(1, Math.trunc(page)),
    pageCount: Math.max(0, Math.trunc(pageCount)),
    ...(totalCount !== undefined && { totalCount: Math.max(0, Math.trunc(totalCount)) }),
  };
};

const mangaIdFromHref = (href: string | undefined): string | undefined => {
  const absolute = resolveHttpsUrl(href, DOMAIN);
  const match = absolute?.match(/^https:\/\/(?:www\.)?mgeko\.cc\/manga\/([^/?#]+)\/?/i);
  return match?.[1] ? encodePaperbackIdComponent(decodePaperbackIdComponent(match[1])) : undefined;
};

export const parseBrowseCards = (html: string, options: { safeMode: boolean }): MgekoCard[] => {
  const $ = load(html);
  const seen = new Set<string>();
  return $("article.comic-card")
    .toArray()
    .flatMap((element): MgekoCard[] => {
      const card = $(element);
      const cover = card.find("img").first();
      const link = card.find("a[href*='/manga/']").first();
      const mangaId = mangaIdFromHref(link.attr("href"));
      const title = clean(cover.attr("alt") || card.find(".comic-card__title").first().text());
      if (!mangaId || !title || seen.has(mangaId)) return [];
      seen.add(mangaId);

      const rawRating = finiteNumber(card.find(".comic-card__stat--rating").first().text());
      const rating = rawRating === undefined ? undefined : Math.min(1, Math.max(0, rawRating / 5));
      const views = finiteNumber(card.find(".comic-card__stat--hot span").first().text());
      const badge = clean(card.find(".comic-card__badge").first().text()) || undefined;
      const imageUrl =
        resolveHttpsUrl(cover.attr("data-src") ?? cover.attr("src"), DOMAIN) ?? FALLBACK_COVER_URL;

      return [
        {
          mangaId,
          title,
          imageUrl,
          contentRating: options.safeMode ? ContentRating.MATURE : ContentRating.ADULT,
          ...(rating !== undefined && { rating }),
          ...(views !== undefined && { views }),
          ...(badge && { badge }),
        },
      ];
    });
};

const tagsFrom = ($: CheerioAPI, selector: string, sort: boolean = false): Tag[] => {
  const seen = new Set<string>();
  const tags = $(selector)
    .toArray()
    .flatMap((element): Tag[] => {
      const id = clean($(element).attr("data-value") ?? $(element).attr("value"));
      const title = clean($(element).text());
      if (!id || !title || seen.has(id)) return [];
      seen.add(id);
      return [{ id, title }];
    });
  return sort ? tags.sort((left, right) => left.title.localeCompare(right.title)) : tags;
};

export const parseFilterOptions = (html: string): MgekoFilterOptions => {
  const $ = load(html);
  return {
    genres: tagsFrom($, "button.chip[data-group='include_genres'][data-value]", true),
    statuses: tagsFrom($, "select#bf-status option[value]:not([value=''])"),
    types: tagsFrom($, "select#bf-type option[value]:not([value=''])"),
  };
};

const titleKey = (value: string): string =>
  value
    .normalize("NFKD")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");

const splitSecondaryTitles = (value: string, primaryTitle: string): string[] => {
  const seen = new Set([titleKey(primaryTitle), "updating"]);
  return value
    .split(/\s*(?:,|;|\||\n|\r)\s*/)
    .map(clean)
    .filter((title) => {
      const key = titleKey(title);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
};

const mapStatus = (value: string): string | undefined => {
  if (!value) return undefined;
  switch (value.toLowerCase()) {
    case "ongoing":
      return "Ongoing";
    case "completed":
      return "Completed";
    case "hiatus":
      return "Hiatus";
    default:
      return value;
  }
};

export const parseMangaDetails = (html: string, mangaId: string): SourceManga => {
  const $ = load(html);
  const primaryTitle = clean($(".novel-title").first().text());
  if (!primaryTitle) throw new Error("Mgeko did not return a series title.");

  const cover = $("div.fixed-img img, .fixed-img img").first();
  const thumbnailUrl =
    resolveHttpsUrl(cover.attr("data-src") ?? cover.attr("src"), DOMAIN) ?? FALLBACK_COVER_URL;
  const authorText = clean($(".author [itemprop='author'], .author a").first().text());
  const author = /^(?:updating|unknown|n\/a)$/i.test(authorText)
    ? undefined
    : authorText || undefined;
  const genres = $("div.categories li")
    .toArray()
    .map((element) => clean($(element).text()))
    .filter(Boolean);
  const ratingValue = finiteNumber($(".rating-star strong").first().text());
  const rating = ratingValue === undefined ? undefined : Math.min(1, Math.max(0, ratingValue / 5));
  const description = plainTextFromHtml($(".description").first().html() ?? "");
  const synopsis = clean(description.split(/the summary is/i).at(-1));

  const additionalInfo: Record<string, string> = {};
  let status: string | undefined;
  $(".header-stats span").each((_, element) => {
    const label = clean($(element).find("small").text());
    const value = clean($(element).find("strong").text());
    if (!label || !value) return;
    if (label.toLowerCase() === "status") status = mapStatus(value);
    else additionalInfo[label] = value;
  });

  const canonical = resolveHttpsUrl($("link[rel='canonical']").attr("href"), DOMAIN);
  const shareUrl =
    canonical ?? `${DOMAIN}/manga/${encodeURIComponent(decodePaperbackIdComponent(mangaId))}/`;
  return {
    mangaId,
    mangaInfo: {
      primaryTitle,
      secondaryTitles: splitSecondaryTitles(
        clean($(".alternative-title").first().text()),
        primaryTitle,
      ),
      thumbnailUrl,
      synopsis,
      contentRating: contentRatingForTags(genres),
      contentType: "comic",
      ...(status && { status }),
      ...(author && { author }),
      ...(rating !== undefined && { rating }),
      ...(genres.length > 0 && {
        tagGroups: [
          {
            id: "genres",
            title: "Genres",
            tags: genres.map((title) => ({ id: title, title })),
          },
        ],
      }),
      ...(Object.keys(additionalInfo).length > 0 && { additionalInfo }),
      shareUrl,
    },
  };
};

const MONTHS = new Map(
  ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].map(
    (month, index) => [month, index],
  ),
);

export const parseDate = (value: unknown): Date | undefined => {
  if (value instanceof Date) {
    const copy = new Date(value.getTime());
    return Number.isNaN(copy.getTime()) ? undefined : copy;
  }
  if (typeof value !== "string") return undefined;
  const match = value
    .trim()
    .match(/^([A-Za-z]+)\.?\s+(\d{1,2}),\s+(\d{4})(?:,\s+(\d{1,2}):(\d{2})\s+([ap])\.?m\.?)?$/i);
  if (!match) return undefined;
  const month = MONTHS.get(match[1]!.slice(0, 3).toLowerCase());
  if (month === undefined) return undefined;
  const day = Number(match[2]);
  const year = Number(match[3]);
  let hour = Number(match[4] ?? 0);
  const minute = Number(match[5] ?? 0);
  const meridiem = match[6]?.toLowerCase();
  if (meridiem === "p" && hour < 12) hour += 12;
  if (meridiem === "a" && hour === 12) hour = 0;
  const date = new Date(Date.UTC(year, month, day, hour, minute));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute
  ) {
    return undefined;
  }
  return date;
};

const chapterIdFromHref = (href: string | undefined): string | undefined => {
  const absolute = resolveHttpsUrl(href, DOMAIN);
  const match = absolute?.match(/^https:\/\/(?:www\.)?mgeko\.cc\/reader\/en\/([^/?#]+)\/?/i);
  return match?.[1] ? encodePaperbackIdComponent(decodePaperbackIdComponent(match[1])) : undefined;
};

const chapterNumber = (chapterId: string): number => {
  const decoded = decodePaperbackIdComponent(chapterId);
  const marker = decoded.toLowerCase().lastIndexOf("-chapter-");
  if (marker < 0) return 0;
  const match = decoded.slice(marker + 9).match(/^(\d+)(?:[-.](\d+))?(?:-|$)/);
  if (!match?.[1]) return 0;
  const number = Number(match[2] ? `${match[1]}.${match[2]}` : match[1]);
  return Number.isFinite(number) ? number : 0;
};

export const parseChapters = (html: string, sourceManga: SourceManga): Chapter[] => {
  const $ = load(html);
  const chapters = $("ul.chapter-list li")
    .toArray()
    .flatMap((element): Chapter[] => {
      const row = $(element);
      const chapterId = chapterIdFromHref(row.find("a").first().attr("href"));
      if (!chapterId) return [];
      const chapNum = chapterNumber(chapterId);
      const label = clean(row.find("strong.chapter-title, .chapter-number").first().text());
      const title = /^\d+(?:[-.]\d+)?(?:-eng-li)?$/i.test(label) ? undefined : label || undefined;
      const publishDate = parseDate(row.find("time.chapter-update").attr("datetime"));
      return [
        {
          chapterId,
          sourceManga,
          langCode: "en",
          chapNum,
          ...(title && { title }),
          ...(publishDate && { publishDate }),
        },
      ];
    })
    .sort((left, right) => {
      const numberDifference = left.chapNum - right.chapNum;
      if (numberDifference !== 0) return numberDifference;
      const dateDifference =
        (left.publishDate?.getTime() ?? 0) - (right.publishDate?.getTime() ?? 0);
      return dateDifference || left.chapterId.localeCompare(right.chapterId);
    });
  return chapters.map((chapter, sortingIndex) => ({ ...chapter, sortingIndex }));
};

export const parseChapterDetails = (html: string, chapter: Chapter): ChapterDetails => {
  const $ = load(html);
  const seen = new Set<string>();
  const pages = $(".page-in img")
    .toArray()
    .flatMap((element): string[] => {
      const url = resolveHttpsUrl(
        $(element).attr("data-src") ?? $(element).attr("data-lazy-src") ?? $(element).attr("src"),
        DOMAIN,
      );
      if (!url || PLACEHOLDER_IMAGE.test(url) || seen.has(url)) return [];
      seen.add(url);
      return [url];
    });
  if (pages.length === 0) throw new Error("Mgeko returned no readable pages for this chapter.");
  return { id: chapter.chapterId, mangaId: chapter.sourceManga.mangaId, pages };
};
