import {
  ContentRating,
  type Chapter,
  type ChapterDetails,
  type SourceManga,
} from "@paperback/types";
import { load } from "cheerio";

import { contentRatingForTags, plainTextFromHtml } from "../shared/html.js";
import { decodePaperbackIdComponent, encodePaperbackIdComponent } from "../shared/ids.js";
import { resolveHttpsUrl } from "../shared/url.js";
import type { TempleCard, TempleCatalogPage } from "./models.js";
import { DOMAIN, buildChapterUrl, buildMangaUrl } from "./network.js";
import { TEMPLE_SITE } from "./site.js";

const clean = (value: string | null | undefined): string =>
  (value ?? "").replace(/ /g, " ").replace(/\s+/g, " ").trim();

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const FALLBACK_COVER = `${DOMAIN}/icon.webp`;

const encodeSlug = (slug: string): string | undefined => {
  try {
    return encodePaperbackIdComponent(decodePaperbackIdComponent(slug.trim().toLowerCase()));
  } catch {
    return undefined;
  }
};

export interface TempleSearchProject {
  title: string;
  series_slug: string;
  thumbnail: string;
  badge?: string;
  status?: string;
  alternative_names?: string;
}

export const parseSearchResponse = (value: unknown): TempleCatalogPage => {
  const record = asRecord(value);
  const projects = asArray(record.projects);
  const seen = new Set<string>();
  const items = projects.flatMap((entry): TempleCard[] => {
    const project = asRecord(entry);
    const slug =
      typeof project.series_slug === "string" ? project.series_slug.trim().toLowerCase() : "";
    const title = clean(typeof project.title === "string" ? project.title : "");
    if (!slug || !title || seen.has(slug)) return [];
    seen.add(slug);
    const mangaId = encodeSlug(slug);
    if (!mangaId) return [];
    const badge = clean(typeof project.badge === "string" ? project.badge : "");
    const status = clean(typeof project.status === "string" ? project.status : "");
    const subtitle = [badge, status].filter(Boolean).join(" · ") || undefined;
    return [
      {
        mangaId,
        title,
        imageUrl: resolveHttpsUrl(project.thumbnail, DOMAIN) ?? FALLBACK_COVER,
        contentRating: contentRatingForTags([badge, status]),
        ...(subtitle && { subtitle }),
      },
    ];
  });
  const total = typeof record.total === "number" ? record.total : items.length;
  const page = typeof record.page === "number" ? record.page : 1;
  const limit = typeof record.limit === "number" ? record.limit : 15;
  return { items, hasNextPage: page * limit < total };
};

export const parseComicsCards = (html: string): TempleCatalogPage => {
  const $ = load(html);
  const seen = new Set<string>();
  const items: TempleCard[] = [];
  $("a[href*='/comic/']").each((_, element) => {
    const link = $(element);
    const href = link.attr("href");
    if (!href || /\/chapter-/.test(href)) return;
    const absolute = resolveHttpsUrl(href, DOMAIN);
    const match = absolute?.match(/^https:\/\/(?:www\.)?templetoons\.com\/comic\/([^/?#]+)\/?$/i);
    const slug = match?.[1]?.trim().toLowerCase();
    if (!slug || seen.has(slug)) return;
    const card = link.closest("div");
    const title = clean(link.attr("title")) || clean(card.find("p, span").first().text());
    if (!title) return;
    seen.add(slug);
    const mangaId = encodeSlug(slug);
    if (!mangaId) return;
    const imageUrl =
      resolveHttpsUrl(card.find("img").first().attr("src"), DOMAIN) ?? FALLBACK_COVER;
    items.push({ mangaId, title, imageUrl, contentRating: ContentRating.MATURE });
  });
  return { items, hasNextPage: false };
};

export const parseMangaDetails = (html: string, mangaId: string): SourceManga => {
  const $ = load(html);
  const title =
    clean($("h1").first().text()) || clean($('meta[property="og:title"]').attr("content"));
  if (!title) throw new Error("Temple series page did not contain a title.");
  const chips = $("div.flex.flex-row.flex-wrap p")
    .toArray()
    .map((element) => clean($(element).text()))
    .filter(Boolean);
  const badge = chips.find((chip) => chip.startsWith("+")) ?? "";
  const genres = chips.filter((chip) => !chip.startsWith("+"));
  const views = clean(
    $("span, div")
      .filter((_, element) => clean($(element).text()).endsWith("views"))
      .first()
      .text(),
  );
  const description = clean(
    $("p")
      .filter((_, element) => clean($(element).text()).length > 80)
      .first()
      .text(),
  );
  const cover =
    resolveHttpsUrl(
      $(`img[alt^="${title.split(" ")[0]}"]`)
        .first()
        .attr("src") ?? $('meta[property="og:image"]').attr("content"),
      DOMAIN,
    ) ?? FALLBACK_COVER;
  const bodyText = $.text();
  const status = /Completed/.test(bodyText.slice(0, 4000)) ? "Completed" : "Ongoing";
  return {
    mangaId,
    mangaInfo: {
      primaryTitle: plainTextFromHtml(title),
      secondaryTitles: [],
      thumbnailUrl: cover,
      synopsis: description || title,
      contentRating: contentRatingForTags([badge, ...genres]),
      contentType: "comic",
      status,
      ...(views && { additionalInfo: { Views: views } }),
      shareUrl: buildMangaUrl(mangaId),
      tagGroups:
        genres.length > 0
          ? [
              {
                id: "genres",
                title: "Genres",
                tags: genres.map((tag) => ({
                  id: tag.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
                  title: tag,
                })),
              },
            ]
          : [],
    },
  };
};

const chapterNumberFromHref = (href: string): number => {
  const match = href.match(/\/chapter-(\d+(?:\.\d+)?)\/?$/i);
  return match?.[1] ? Number(match[1]) : Number.NaN;
};

export const parseChapters = (html: string, sourceManga: SourceManga): Chapter[] => {
  const $ = load(html);
  const seen = new Set<string>();
  const chapters: Chapter[] = [];
  $("a[href*='chapter-']").each((_, element) => {
    const link = $(element);
    const href = link.attr("href") ?? "";
    const match = href.match(/(?:^|\/)([^/?#]+)\/chapter-(\d+(?:\.\d+)?)\/?$/i);
    if (!match?.[1] || !match[2]) return;
    const slug = `${match[1].toLowerCase()}-chapter-${match[2]}`;
    if (seen.has(slug)) return;
    seen.add(slug);
    const mangaId = encodeSlug(slug);
    if (!mangaId) return;
    const title = clean(link.find("span").first().text()) || `Chapter ${match[2]}`;
    const locked = /PREMIUM/i.test(link.text());
    const dateText = clean(link.text().replace(title, ""));
    const publishDate = dateText ? new Date(dateText) : undefined;
    const chapNum = chapterNumberFromHref(href);
    chapters.push({
      sourceManga,
      chapterId: mangaId,
      langCode: "en",
      chapNum: Number.isFinite(chapNum) ? chapNum : 0,
      title,
      ...(publishDate && !Number.isNaN(publishDate.getTime()) && { publishDate }),
      additionalInfo: {
        url: buildChapterUrl(mangaId),
        ...(locked && { locked: "true" }),
      },
    });
  });
  if (chapters.length === 0) throw new Error("Temple returned no chapters from the series page.");
  const sorted = chapters.sort(
    (left, right) => right.chapNum - left.chapNum || left.chapterId.localeCompare(right.chapterId),
  );
  return sorted.map((chapter, sortingIndex) => ({ ...chapter, sortingIndex }));
};

export const parseChapterDetails = (html: string, chapter: Chapter): ChapterDetails => {
  const matches = [
    ...html.matchAll(
      /https:\/\/media\.templetoons\.com\/file\/[^"'\\\s]+\/uploads\/series\/[^"'\\\s]+\.(?:jpg|jpeg|png|webp)/gi,
    ),
  ];
  const pages = [...new Set(matches.map((match) => match[0].replace(/\\+$/, "")))].filter((url) =>
    url.startsWith(`https://${TEMPLE_SITE.mediaHost}/`),
  );
  if (pages.length === 0) {
    const premium = /PREMIUM|premium/i.test(html.slice(0, 20000));
    throw new Error(
      premium
        ? `Temple chapter ${chapter.chapterId} is premium and requires an account.`
        : `Temple chapter ${chapter.chapterId} returned no pages.`,
    );
  }
  return { id: chapter.chapterId, mangaId: chapter.sourceManga.mangaId, pages };
};
