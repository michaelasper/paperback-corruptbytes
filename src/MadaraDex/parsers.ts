import {
  ContentRating,
  type Chapter,
  type ChapterDetails,
  type SourceManga,
  type Tag,
} from "@paperback/types";
import { load, type Cheerio, type CheerioAPI } from "cheerio";
import type { AnyNode } from "domhandler";

import { contentRatingForTags, plainTextFromHtml, sanitizeChapterHtml } from "../shared/html.js";
import { encodePaperbackIdComponent } from "../shared/ids.js";
import { resolveHttpsUrl, urlPathSlug } from "../shared/url.js";
import type { MadaraCard, MadaraCatalogPage, MadaraFilterOptions } from "./models.js";
import { DOMAIN } from "./network.js";
import { decryptProtectedPages } from "./protector.js";

const FALLBACK_COVER_URL = `${DOMAIN}/favicon.ico`;
const PLACEHOLDER_IMAGE = /(?:dflazy|lazyload|placeholder|loading)[^/]*$/i;

const clean = (value: string | null | undefined): string =>
  (value ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const uniqueStrings = (values: string[]): string[] => [...new Set(values.filter(Boolean))];

const numericFromCover = (element: Cheerio<AnyNode>): string | undefined => {
  const alt = clean(element.attr("alt"));
  if (/^\d+$/.test(alt)) return alt;
  const source = clean(element.attr("data-src") ?? element.attr("src"));
  return source.match(/\/(\d+)(?:-[^/]*)?\.(?:avif|gif|jpe?g|png|webp)(?:[?#].*)?$/i)?.[1];
};

const numericFromCard = (card: Cheerio<AnyNode>): string | undefined => {
  const item = card.find("[data-post-id], [id^='manga-item-']").first();
  const explicit = clean(item.attr("data-post-id"));
  if (/^\d+$/.test(explicit)) return explicit;
  const fromId = clean(item.attr("id")).match(/^manga-item-(\d+)$/)?.[1];
  return fromId ?? numericFromCover(card.find("img").first());
};

const chapterIdFromHref = (href: string | undefined): string | undefined => {
  const url = resolveHttpsUrl(href, DOMAIN);
  if (!url) return undefined;
  const segment = urlPathSlug(url);
  return segment && /^chapter-[\p{L}\p{N}._~-]+$/u.test(segment) ? segment : undefined;
};

const ratingFrom = (card: Cheerio<AnyNode>): number | undefined => {
  const raw = Number.parseFloat(clean(card.find(".post-total-rating .score").first().text()));
  return Number.isFinite(raw) ? Math.min(1, Math.max(0, raw / 5)) : undefined;
};

const cardRating = (card: Cheerio<AnyNode>): ContentRating => {
  if (card.find(".manga-title-badges.adult, .adult.badge-round").length > 0) {
    return ContentRating.ADULT;
  }
  const genres = card
    .find(".mg_genres .summary-content a")
    .toArray()
    .map((element) => clean(card.find(element).text()));
  const derived = contentRatingForTags(genres);
  return derived === ContentRating.ADULT ? derived : ContentRating.MATURE;
};

export const parseCatalogCards = (html: string): MadaraCard[] => {
  const $ = load(html);
  const roots = $("#loop-content .page-item-detail, .c-tabs-item__content").toArray();
  const seen = new Set<string>();
  return roots.flatMap((element): MadaraCard[] => {
    const card = $(element);
    const mangaId = numericFromCard(card);
    const title = clean(
      card
        .find(".item-summary .post-title a, .tab-summary .post-title a, .post-title a")
        .first()
        .text(),
    );
    if (!mangaId || !title || seen.has(mangaId)) return [];
    seen.add(mangaId);
    const cover = card.find(".item-thumb img, .tab-thumb img, img").first();
    const imageUrl =
      resolveHttpsUrl(
        cover.attr("data-src") ?? cover.attr("data-lazy-src") ?? cover.attr("src"),
        DOMAIN,
      ) ?? FALLBACK_COVER_URL;
    const latest = card
      .find(".list-chapter .chapter a, .latest-chap .chapter a, .latest-chap a")
      .first();
    const latestChapterId = chapterIdFromHref(latest.attr("href"));
    const latestChapterTitle = clean(latest.text()) || undefined;
    const rating = ratingFrom(card);
    return [
      {
        mangaId,
        title,
        imageUrl,
        contentRating: cardRating(card),
        ...(rating !== undefined && { rating }),
        ...(latestChapterId && { latestChapterId }),
        ...(latestChapterId && latestChapterTitle && { latestChapterTitle }),
      },
    ];
  });
};

export const parseCatalogPage = (html: string): MadaraCatalogPage => {
  const $ = load(html);
  return {
    items: parseCatalogCards(html),
    hasNextPage: $("a.nextpostslink, a[rel='next']").length > 0,
  };
};

const tagsFromInputs = ($: CheerioAPI, name: string): Tag[] => {
  const seen = new Set<string>();
  return $(`input[name='${name}'][value]`)
    .toArray()
    .flatMap((element): Tag[] => {
      const input = $(element);
      const id = clean(input.attr("value"));
      const inputId = clean(input.attr("id"));
      const title = clean(inputId ? $(`label[for='${inputId}']`).first().text() : "");
      if (!id || !title || seen.has(id)) return [];
      seen.add(id);
      return [{ id, title }];
    });
};

export const parseFilterOptions = (html: string): MadaraFilterOptions => {
  const $ = load(html);
  return { genres: tagsFromInputs($, "genre[]"), statuses: tagsFromInputs($, "status[]") };
};

const itemValue = ($: CheerioAPI, label: RegExp): Cheerio<AnyNode> | undefined => {
  const element = $(".post-content_item")
    .toArray()
    .find((candidate) => label.test(clean($(candidate).find(".summary-heading").text())));
  return element ? $(element).find(".summary-content").first() : undefined;
};

const splitTitles = (value: string, primary: string): string[] => {
  const primaryKey = primary.toLocaleLowerCase();
  return uniqueStrings(
    value
      .split(/\s*(?:,|;|\||\n|\r)\s*/)
      .map(clean)
      .filter((title) => title && title.toLocaleLowerCase() !== primaryKey),
  );
};

export const parseNumericMangaId = (html: string): string | undefined => {
  const $ = load(html);
  const candidates = [
    $("link[rel='shortlink']").attr("href"),
    $("input.rating-post-id").attr("value"),
    $(".summary_image img").attr("alt"),
  ];
  for (const candidate of candidates) {
    const value = clean(candidate);
    const queryId = value.match(/[?&]p=(\d+)(?:&|$)/)?.[1];
    if (queryId) return queryId;
    if (/^\d+$/.test(value)) return value;
  }
  return undefined;
};

export const parseMangaDetails = (html: string, mangaId: string): SourceManga => {
  const $ = load(html);
  const primaryTitle = clean($(".post-title h1").first().text());
  if (!primaryTitle) throw new Error("MadaraDex did not return a series title.");
  const cover = $(".summary_image img").first();
  const thumbnailUrl =
    resolveHttpsUrl(
      cover.attr("data-src") ?? cover.attr("data-lazy-src") ?? cover.attr("src"),
      DOMAIN,
    ) ?? FALLBACK_COVER_URL;
  const alternative = clean(itemValue($, /^alternative$/i)?.text());
  const author = clean(itemValue($, /^author(?:\(s\))?$/i)?.text()) || undefined;
  const artist = clean(itemValue($, /^artist(?:\(s\))?$/i)?.text()) || undefined;
  const status = clean(itemValue($, /^status$/i)?.text()) || undefined;
  const genres =
    itemValue($, /^genre(?:\(s\))?$/i)
      ?.find("a")
      .toArray()
      .map((element) => clean($(element).text())) ?? [];
  const synopsis = plainTextFromHtml(
    $(".description-summary .summary__content, .description-summary").first().html() ?? "",
  );
  const rawRating = Number.parseFloat(clean($("#averagerate").first().text()));
  const rating = Number.isFinite(rawRating) ? Math.min(1, Math.max(0, rawRating / 5)) : undefined;
  const canonical = resolveHttpsUrl($("link[rel='canonical']").attr("href"), DOMAIN);
  const adultBadge =
    $(".post-title .manga-title-badges.adult, .post-title .adult.badge-round").length > 0;
  const derivedRating = contentRatingForTags(genres);
  const contentRating = adultBadge ? ContentRating.ADULT : derivedRating;
  return {
    mangaId,
    mangaInfo: {
      primaryTitle,
      secondaryTitles: splitTitles(alternative, primaryTitle),
      thumbnailUrl,
      synopsis,
      contentRating,
      contentType: "comic",
      ...(author && { author }),
      ...(artist && { artist }),
      ...(status && { status }),
      ...(rating !== undefined && { rating }),
      ...(genres.length > 0 && {
        tagGroups: [
          {
            id: "genres",
            title: "Genres",
            tags: genres.map((title) => ({ id: encodePaperbackIdComponent(title), title })),
          },
        ],
      }),
      ...(canonical && { shareUrl: canonical }),
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
    const result = new Date(value.getTime());
    return Number.isNaN(result.getTime()) ? undefined : result;
  }
  if (typeof value !== "string") return undefined;
  const match = value.trim().match(/^([A-Za-z]+)\.?\s+(\d{1,2}),\s+(\d{4})$/);
  if (!match) return undefined;
  const month = MONTHS.get(match[1]!.slice(0, 3).toLowerCase());
  const day = Number(match[2]);
  const year = Number(match[3]);
  if (month === undefined || day < 1 || day > 31 || year < 1900 || year > 9999) return undefined;
  const result = new Date(Date.UTC(year, month, day));
  return result.getUTCFullYear() === year &&
    result.getUTCMonth() === month &&
    result.getUTCDate() === day
    ? result
    : undefined;
};

const chapterNumber = (label: string, chapterId: string): number => {
  const fromLabel = label.match(/(?:chapter|ch\.?)[\s:#-]*(\d+(?:\.\d+)?)/i)?.[1];
  if (fromLabel) return Number(fromLabel);
  const suffix = chapterId.match(/^chapter-(\d+)(?:-(\d+))?$/i);
  if (suffix?.[1]) return Number(suffix[2] ? `${suffix[1]}.${suffix[2]}` : suffix[1]);
  return 0;
};

const chapterTitle = (label: string, number: number): string | undefined => {
  if (/^prologue$/i.test(label)) return "Prologue";
  const stripped = clean(label.replace(/^(?:chapter|ch\.?)\s*\d+(?:\.\d+)?\s*(?:[-–—:]\s*)?/i, ""));
  return stripped && stripped !== String(number) ? stripped : undefined;
};

export const parseChapters = (html: string, sourceManga: SourceManga): Chapter[] => {
  const $ = load(html);
  const seen = new Set<string>();
  const chapters = $("li.wp-manga-chapter")
    .toArray()
    .flatMap((element): Chapter[] => {
      const row = $(element);
      const link = row.find("a[href]").first();
      const chapterId = chapterIdFromHref(link.attr("href"));
      const url = resolveHttpsUrl(link.attr("href"), DOMAIN);
      const label = clean(link.text());
      if (!chapterId || !url || !label || seen.has(chapterId)) return [];
      seen.add(chapterId);
      const chapNum = chapterNumber(label, chapterId);
      const title = chapterTitle(label, chapNum);
      const publishDate = parseDate(row.find(".chapter-release-date").first().text());
      return [
        {
          chapterId,
          sourceManga,
          langCode: "en",
          chapNum,
          ...(title && { title }),
          ...(publishDate && { publishDate }),
          additionalInfo: { url },
        },
      ];
    })
    .sort(
      (left, right) =>
        left.chapNum - right.chapNum || left.chapterId.localeCompare(right.chapterId),
    );
  return chapters.map((chapter, sortingIndex) => ({ ...chapter, sortingIndex }));
};

export const parseChapterDetails = async (
  html: string,
  chapter: Chapter,
): Promise<ChapterDetails> => {
  const $ = load(html);
  const protectedPages = await decryptProtectedPages($);
  const pageCandidates =
    protectedPages ??
    $(".reading-content img")
      .toArray()
      .map((element) => {
        const image = $(element);
        return image.attr("data-src") ?? image.attr("data-lazy-src") ?? image.attr("src") ?? "";
      });
  const pages = uniqueStrings(
    pageCandidates.flatMap((value) => {
      const resolved = resolveHttpsUrl(clean(value), DOMAIN);
      return resolved && !PLACEHOLDER_IMAGE.test(resolved) ? [resolved] : [];
    }),
  );
  if (pages.length > 0) {
    return { id: chapter.chapterId, mangaId: chapter.sourceManga.mangaId, pages };
  }

  const novel = $(".reading-content .text-left, .reading-content .entry-content").first();
  if (novel.length > 0 && clean(novel.text())) {
    return {
      id: chapter.chapterId,
      mangaId: chapter.sourceManga.mangaId,
      type: "html",
      html: sanitizeChapterHtml(novel.html() ?? "", chapter.additionalInfo?.url ?? DOMAIN),
    };
  }
  throw new Error("MadaraDex returned no readable pages or novel content for this chapter.");
};
