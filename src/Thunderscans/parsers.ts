import {
  ContentRating,
  type Chapter,
  type ChapterDetails,
  type SourceManga,
  type Tag,
} from "@paperback/types";
import { load, type CheerioAPI } from "cheerio";
import type { AnyNode } from "domhandler";

import { contentRatingForTags, plainTextFromHtml, sanitizeChapterHtml } from "../shared/html.js";
import { resolveHttpsUrl } from "../shared/url.js";
import type {
  HomeFeedId,
  ParseChapterListOptions,
  ParsedHomeFeed,
  ParsedListPage,
  ThunderListItem,
  ThunderSearchMetadata,
} from "./models.js";
import { DOMAIN } from "./network.js";

const FALLBACK_COVER_URL = `${DOMAIN}/favicon.ico`;

const clean = (value: string | null | undefined): string =>
  (value ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const asText = (value: unknown): string | undefined => {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
};

const asNumber = (value: unknown): number | undefined => {
  const text = asText(value);
  if (!text) return undefined;
  const match = text.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  if (!match) return undefined;
  const number = Number(match[0]);
  return Number.isFinite(number) ? number : undefined;
};

const normalizedRating = (value: unknown): number | undefined => {
  const rating = asNumber(value);
  if (rating === undefined) return undefined;
  return Number(Math.min(1, Math.max(0, rating > 1 ? rating / 10 : rating)).toFixed(3));
};

export const parseDate = (value: unknown): Date | undefined => {
  if (value instanceof Date) {
    const copy = new Date(value.getTime());
    return Number.isNaN(copy.getTime()) ? undefined : copy;
  }
  const text = asText(value);
  if (
    !text ||
    /^(?:new|today|yesterday|\d+\s+(?:minute|hour|day|week|month)s?)(?:\s+ago)?$/i.test(text)
  ) {
    return undefined;
  }
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? undefined : date;
};

export const parseSeriesSlug = (value: unknown): string | undefined => {
  const absolute = resolveHttpsUrl(value, DOMAIN);
  const match = absolute?.match(
    /^https:\/\/en-thunderscans\.com\/comics\/([^/?#]+)\/?(?:[?#].*)?$/i,
  );
  if (!match?.[1]) return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
};

const chapterIdFromText = (value: string): string | undefined =>
  clean(value).match(/(?:chapter\s*)?(\d+(?:\.\d+)?)/i)?.[1];

const cardFrom = ($: CheerioAPI, element: AnyNode): ThunderListItem | undefined => {
  const card = $(element);
  const seriesLink = card
    .find("a[href*='/comics/']")
    .toArray()
    .find((candidate) => parseSeriesSlug($(candidate).attr("href")) !== undefined);
  const href = seriesLink ? $(seriesLink).attr("href") : undefined;
  const mangaId = parseSeriesSlug(href);
  const title = clean(
    card.find(".tt").first().text() ||
      (seriesLink ? $(seriesLink).attr("title") : undefined) ||
      card.find("img").first().attr("alt"),
  );
  if (!mangaId || !title) return undefined;

  const image = card.find("img").first();
  const imageUrl =
    resolveHttpsUrl(
      image.attr("data-src") ?? image.attr("data-lazy-src") ?? image.attr("src"),
      DOMAIN,
    ) ?? FALLBACK_COVER_URL;
  const status = clean(card.find(".status i").first().text()) || undefined;
  const isNovel = card.find(".novelabel").length > 0 || /\bnovel\b/i.test(title);
  const chapterLabel = clean(card.find(".chapter-list .epxs, .adds .epxs, .epxs").first().text());
  const latestChapterId = chapterIdFromText(chapterLabel);
  const subtitle = [
    latestChapterId ? `Chapter ${latestChapterId}` : undefined,
    isNovel ? "Novel" : undefined,
    status,
  ]
    .filter((part): part is string => Boolean(part))
    .join(" • ");
  const rating = normalizedRating(card.find(".numscore").first().text());
  const publishDate = parseDate(
    card.find(".epxdate, time").first().attr("datetime") ??
      card.find(".epxdate, time").first().text(),
  );

  return {
    mangaId,
    title,
    imageUrl,
    // Directory and home cards do not expose genres. The source carries
    // mature titles, so unknown cards must never be mislabeled as safe.
    contentRating: ContentRating.MATURE,
    ...(subtitle && { subtitle }),
    ...(isNovel && { contentType: "novel" as const }),
    ...(status && { status }),
    ...(rating !== undefined && { rating }),
    ...(latestChapterId && { latestChapterId }),
    ...(publishDate && { publishDate }),
  };
};

const cardsFrom = ($: CheerioAPI, elements: AnyNode[]): ThunderListItem[] => {
  const seen = new Set<string>();
  return elements.flatMap((element): ThunderListItem[] => {
    const item = cardFrom($, element);
    if (!item || seen.has(item.mangaId)) return [];
    seen.add(item.mangaId);
    return [item];
  });
};

export const parseDirectoryPage = (html: string): ParsedListPage => {
  const $ = load(html);
  return {
    items: cardsFrom($, $(".listupd .bsx").toArray()),
    hasNextPage: $(".pagination .next, a.next.page-numbers, .pagination a[rel='next']").length > 0,
  };
};

export const parseGenres = (html: string): Tag[] => {
  const $ = load(html);
  const seen = new Set<string>();
  return $("input[name='genre[]'][value]")
    .toArray()
    .flatMap((input): Tag[] => {
      const id = clean($(input).attr("value"));
      const inputId = clean($(input).attr("id"));
      const title = clean(
        (inputId
          ? $(`label[for='${inputId.replaceAll("'", "\\'")}']`)
              .first()
              .text()
          : "") || $(input).parent("label").text(),
      );
      if (!id || !title || seen.has(id)) return [];
      seen.add(id);
      return [{ id, title }];
    })
    .sort((left, right) => left.title.localeCompare(right.title));
};

const sectionWithHeading = ($: CheerioAPI, title: string) =>
  $("h1,h2,h3")
    .filter((_, heading) => clean($(heading).text()).toLowerCase() === title.toLowerCase())
    .first()
    .closest(".bixbox");

export const parseHomeFeed = (html: string, feed: HomeFeedId): ParsedHomeFeed => {
  const $ = load(html);
  if (feed === "latestComics") {
    const nextPage = asNumber($("#load-more").attr("data-page"));
    return {
      items: cardsFrom($, $("#manga-posts .bsx").toArray()),
      ...(nextPage !== undefined && { nextPage }),
    };
  }
  if (feed === "latestNovels") {
    const nextPage = asNumber($("#load-more-novel").attr("data-page"));
    return {
      items: cardsFrom($, $("#novel-posts .bsx").toArray()),
      ...(nextPage !== undefined && { nextPage }),
    };
  }

  const section = sectionWithHeading($, feed === "popular" ? "Popular Today" : "Editor's Pick");
  return { items: cardsFrom($, section.find(".pop-list .bsx").toArray()) };
};

const autocompleteRecords = (value: unknown): Record<string, unknown>[] => {
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      const record = asRecord(item);
      return Array.isArray(record.all) ? autocompleteRecords(record.all) : [record];
    });
  }
  const record = asRecord(value);
  for (const key of ["series", "all", "data", "results"]) {
    if (Array.isArray(record[key])) return autocompleteRecords(record[key]);
  }
  return [];
};

const genreNames = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value.map(asText).filter((name): name is string => Boolean(name));
  }
  return (asText(value) ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
};

const matchesMetadata = (
  record: Record<string, unknown>,
  metadata: ThunderSearchMetadata | undefined,
): boolean => {
  const status = asText(record.post_status)?.toLowerCase();
  const type = asText(record.post_type)?.toLowerCase();
  if (
    metadata?.status?.length &&
    !metadata.status.some((value) => value.toLowerCase() === status)
  ) {
    return false;
  }
  if (metadata?.type?.length && !metadata.type.some((value) => value.toLowerCase() === type)) {
    return false;
  }

  const genres = new Set(genreNames(record.post_genres).map((name) => name.toLowerCase()));
  for (const [name, state] of Object.entries(metadata?.genres ?? {})) {
    const included = genres.has(name.toLowerCase());
    if ((state === "included" && !included) || (state === "excluded" && included)) return false;
  }
  return true;
};

export const parseAutocompleteResults = (
  value: unknown,
  metadata?: ThunderSearchMetadata,
): ThunderListItem[] =>
  autocompleteRecords(value).flatMap((record): ThunderListItem[] => {
    if (!matchesMetadata(record, metadata)) return [];
    const mangaId = parseSeriesSlug(record.post_link);
    const title = asText(record.post_title);
    if (!mangaId || !title) return [];
    const genres = genreNames(record.post_genres);
    const type = asText(record.post_type);
    const status = asText(record.post_status);
    const isNovel = /novel/i.test(type ?? "") || /\bnovel\b/i.test(title);
    const latestChapterId = chapterIdFromText(asText(record.post_latest) ?? "");
    const subtitle = [
      latestChapterId ? `Chapter ${latestChapterId}` : undefined,
      isNovel ? "Novel" : type,
      status,
    ]
      .filter((part): part is string => Boolean(part))
      .join(" • ");
    return [
      {
        mangaId,
        title,
        imageUrl: resolveHttpsUrl(record.post_image, DOMAIN) ?? FALLBACK_COVER_URL,
        contentRating: contentRatingForTags(genres),
        ...(subtitle && { subtitle }),
        ...(isNovel && { contentType: "novel" as const }),
        ...(status && { status }),
        ...(latestChapterId && { latestChapterId }),
      },
    ];
  });

const metadataMap = ($: CheerioAPI): Map<string, string> => {
  const result = new Map<string, string>();
  $(".tsinfo .imptdt").each((_, element) => {
    const row = $(element);
    const key = clean(row.find("h1").first().text()).toLowerCase();
    const value = clean(row.find("i").first().text());
    if (key && value) result.set(key, value);
  });
  return result;
};

const alternateTitles = (value: string, primaryTitle: string): string[] => {
  const seen = new Set([primaryTitle.toLowerCase()]);
  return value
    .split(/\s*(?:\||;|\n|\r|\s+\/\s+)\s*/)
    .map(clean)
    .filter((title) => {
      const normalized = title.toLowerCase();
      if (!normalized || seen.has(normalized)) return false;
      seen.add(normalized);
      return true;
    });
};

export const parseMangaDetails = (html: string, requestedMangaId?: string): SourceManga => {
  const $ = load(html);
  const canonical = $("link[rel='canonical']").first().attr("href");
  const slug = parseSeriesSlug(canonical);
  if (!slug) throw new Error("Thunder Scans did not return a valid series URL.");
  const primaryTitle = clean($("h1.entry-title").first().text());
  if (!primaryTitle) throw new Error("Thunder Scans did not return a series title.");

  const meta = metadataMap($);
  const genres = $(".genres-container a[rel='tag'], .mgen a[rel='tag']")
    .toArray()
    .map((element) => clean($(element).text()))
    .filter(Boolean);
  const tags = genres.map((title) => ({
    id:
      parseSeriesSlug(
        $("a")
          .filter((_, candidate) => clean($(candidate).text()) === title)
          .attr("href"),
      ) ??
      title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, ""),
    title,
  }));
  const contentType = /novel/i.test(meta.get("type") ?? primaryTitle) ? "novel" : "comic";
  const thumbnailUrl =
    resolveHttpsUrl(
      $(".thumb img").first().attr("data-src") ?? $(".thumb img").first().attr("src"),
      DOMAIN,
    ) ?? FALLBACK_COVER_URL;
  const postId = resolveHttpsUrl($("link[rel='shortlink']").attr("href"), DOMAIN)?.match(
    /[?&]p=(\d+)/,
  )?.[1];
  const rating = normalizedRating($(".main-info .numscore").first().text());
  const secondaryTitles = alternateTitles(
    clean($(".alternative .desktop-titles").first().text()),
    primaryTitle,
  );
  const additionalInfo: Record<string, string> = { slug };
  if (postId) additionalInfo.postId = postId;

  return {
    mangaId: clean(requestedMangaId) || slug,
    mangaInfo: {
      primaryTitle,
      secondaryTitles,
      thumbnailUrl,
      synopsis: plainTextFromHtml($(".entry-content[itemprop='description']").first().html() ?? ""),
      contentRating: contentRatingForTags(genres),
      contentType,
      status: meta.get("status"),
      author: meta.get("author"),
      artist: meta.get("artist"),
      ...(rating !== undefined && { rating }),
      ...(tags.length > 0 && { tagGroups: [{ id: "genres", title: "Genres", tags }] }),
      shareUrl: resolveHttpsUrl(canonical, DOMAIN),
      additionalInfo,
    },
  };
};

const chapterTitle = (label: string, chapterId: string): string | undefined => {
  const escaped = chapterId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const title = clean(label)
    .replace(new RegExp(`^chapter\\s*${escaped}\\s*`, "i"), "")
    .replace(/^[-–—:]+\s*/, "");
  return title || undefined;
};

export const parseChapterList = (
  html: string,
  sourceManga: SourceManga,
  options: ParseChapterListOptions = {},
): Chapter[] => {
  const $ = load(html);
  const showLocked = options.showLocked ?? true;
  const chapters = $("#chapterlist li[data-num]")
    .toArray()
    .flatMap((element): Chapter[] => {
      const row = $(element);
      const anchor = row.find("a").first();
      const chapterId = clean(row.attr("data-num"));
      const chapNum = Number(chapterId);
      if (!chapterId || !Number.isFinite(chapNum)) return [];

      const url = resolveHttpsUrl(anchor.attr("href"), DOMAIN);
      const locked = !url;
      if (locked && !showLocked) return [];
      const rawPrice = clean(anchor.attr("data-coin") ?? row.find(".text-gold").first().text());
      const price = rawPrice.match(/\d[\d,]*(?:\.\d+)?/)?.[0]?.replaceAll(",", "");
      const postId = clean(anchor.attr("data-id"));
      const label = clean(row.find(".chapternum").first().text() || anchor.attr("data-title"));
      const actualTitle = chapterTitle(label, chapterId);
      const lockedTitle = locked
        ? price
          ? `🔒 ${price} coin${price === "1" ? "" : "s"}`
          : "🔒 Locked"
        : undefined;
      const title = locked
        ? actualTitle
          ? `${lockedTitle} • ${actualTitle}`
          : lockedTitle
        : actualTitle;
      const additionalInfo: Record<string, string> = { locked: String(locked) };
      if (url) additionalInfo.url = url;
      if (price) additionalInfo.price = price;
      if (postId) additionalInfo.postId = postId;
      return [
        {
          chapterId,
          sourceManga,
          langCode: "en",
          chapNum,
          title,
          additionalInfo,
          publishDate: parseDate(
            row.find(".chapterdate time").attr("datetime") ?? row.find(".chapterdate").text(),
          ),
        },
      ];
    })
    .sort(
      (left, right) =>
        left.chapNum - right.chapNum || left.chapterId.localeCompare(right.chapterId),
    );

  return chapters.map((chapter, sortingIndex) => ({ ...chapter, sortingIndex }));
};

export const extractCallArgument = (source: string, marker: string): string | undefined => {
  const markerIndex = source.indexOf(marker);
  if (markerIndex < 0) return undefined;
  const start = source.indexOf("(", markerIndex + marker.length);
  if (start < 0) return undefined;
  let depth = 0;
  let quote: string | undefined;
  let escaped = false;

  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "{" || character === "[" || character === "(") depth += 1;
    else if (character === "}" || character === "]" || character === ")") {
      if (character === ")" && depth === 0) return source.slice(start + 1, index);
      depth -= 1;
    }
  }
  return undefined;
};

const readerData = ($: CheerioAPI): Record<string, unknown> | undefined => {
  for (const script of $("script").toArray()) {
    const argument = extractCallArgument($(script).html() ?? "", "ts_reader.run");
    if (!argument) continue;
    try {
      return asRecord(JSON.parse(argument));
    } catch {
      continue;
    }
  }
  return undefined;
};

const readerImages = (reader: Record<string, unknown>): unknown[] => {
  const sources = Array.isArray(reader.sources) ? reader.sources.map(asRecord) : [];
  const preferred = asText(reader.defaultSource);
  const source =
    sources.find(
      (candidate) =>
        preferred &&
        asText(candidate.source) === preferred &&
        Array.isArray(candidate.images) &&
        candidate.images.length > 0,
    ) ??
    sources.find((candidate) => Array.isArray(candidate.images) && candidate.images.length > 0);
  return source && Array.isArray(source.images) ? source.images : [];
};

export const parseChapterDetails = (html: string, chapter: Chapter): ChapterDetails => {
  const $ = load(html);
  const baseUrl = chapter.additionalInfo?.url ?? DOMAIN;
  const reader = readerData($);
  const seen = new Set<string>();
  const pages = readerImages(reader ?? {}).flatMap((candidate): string[] => {
    const url = resolveHttpsUrl(candidate, baseUrl);
    if (!url || seen.has(url)) return [];
    seen.add(url);
    return [url];
  });
  if (pages.length > 0) {
    return { id: chapter.chapterId, mangaId: chapter.sourceManga.mangaId, pages };
  }

  const readerArea = $("#readerarea").first();
  const novel = reader?.is_novel === true || readerArea.hasClass("novel-reader");
  if (novel && readerArea.length > 0 && clean(readerArea.text())) {
    return {
      id: chapter.chapterId,
      mangaId: chapter.sourceManga.mangaId,
      type: "html",
      html: sanitizeChapterHtml(readerArea.html() ?? "", baseUrl),
    };
  }

  const pageText = clean($("body").text());
  if (
    /chapter is locked|buy now|\bcoins?\b/i.test(pageText) ||
    chapter.additionalInfo?.locked === "true"
  ) {
    throw new Error(
      "This chapter is still locked on Thunder Scans. Sign in from the extension settings if you already purchased it.",
    );
  }
  throw new Error("Thunder Scans returned no readable pages or novel content for this chapter.");
};
