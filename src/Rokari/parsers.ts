import {
  ContentRating,
  type Chapter,
  type ChapterDetails,
  type SourceManga,
  type Tag,
} from "@paperback/types";
import { load } from "cheerio";

import { contentRatingForTags, plainTextFromHtml } from "../shared/html.js";
import { decodePaperbackIdComponent, encodePaperbackIdComponent } from "../shared/ids.js";
import { resolveHttpsUrl } from "../shared/url.js";
import type { RokariCard, RokariCatalogPage, RokariFilterOptions } from "./models.js";
import { DOMAIN, buildChapterUrl, buildMangaUrl } from "./network.js";

const FALLBACK_COVER = `${DOMAIN}/wp-content/uploads/2025/06/image.png`;

const clean = (value: string | null | undefined): string =>
  (value ?? "").replace(/ /g, " ").replace(/\s+/g, " ").trim();

const encodeSlug = (slug: string): string | undefined => {
  try {
    return encodePaperbackIdComponent(decodePaperbackIdComponent(slug.trim().toLowerCase()));
  } catch {
    return undefined;
  }
};

const comicSlugFromHref = (href: string | undefined): string | undefined => {
  const absolute = resolveHttpsUrl(href, DOMAIN);
  const match = absolute?.match(/^https:\/\/(?:www\.)?rokaricomics\.com\/manga\/([^/?#]+)\/?$/i);
  return match?.[1]?.trim().toLowerCase();
};

const chapterSlugFromHref = (href: string | undefined): string | undefined => {
  const absolute = resolveHttpsUrl(href, DOMAIN);
  const match = absolute?.match(
    /^https:\/\/(?:www\.)?rokaricomics\.com\/([^/?#]+)-chapter-(\d+(?:\.\d+)?)\/?$/i,
  );
  if (!match?.[1] || !match[2] || match[1].toLowerCase() === "manga") return undefined;
  return `${match[1].toLowerCase()}-chapter-${match[2]}`;
};

const chapterNumberFromSlug = (slug: string): number => {
  const match = slug.match(/-chapter-(\d+(?:\.\d+)?)$/i);
  return match?.[1] ? Number(match[1]) : Number.NaN;
};

export const parseCatalogCards = (html: string): RokariCatalogPage => {
  const $ = load(html);
  const seen = new Set<string>();
  const items: RokariCard[] = [];
  $("a[href*='/manga/']").each((_, element) => {
    const slug = comicSlugFromHref($(element).attr("href"));
    if (!slug || seen.has(slug)) return;
    const card = $(element).closest("div");
    const title =
      clean($(element).attr("title")) || clean(card.find("p, span, h3, h4").first().text());
    if (!title) return;
    seen.add(slug);
    const mangaId = encodeSlug(slug);
    if (!mangaId) return;
    const imageUrl =
      resolveHttpsUrl(card.find("img").first().attr("src"), DOMAIN) ?? FALLBACK_COVER;
    items.push({ mangaId, title, imageUrl, contentRating: ContentRating.ADULT });
  });
  return { items, hasNextPage: false };
};

export const parseSearchCards = (html: string): RokariCatalogPage => {
  const $ = load(html);
  const seen = new Set<string>();
  const items: RokariCard[] = [];
  $("a[href*='/manga/']").each((_, element) => {
    const slug = comicSlugFromHref($(element).attr("href"));
    if (!slug || seen.has(slug)) return;
    seen.add(slug);
    const mangaId = encodeSlug(slug);
    if (!mangaId) return;
    const title = clean($(element).text()) || clean($(element).attr("title")) || slug;
    const card = $(element).closest("div");
    const imageUrl =
      resolveHttpsUrl(card.find("img").first().attr("src"), DOMAIN) ?? FALLBACK_COVER;
    items.push({ mangaId, title, imageUrl, contentRating: ContentRating.ADULT });
  });
  return { items, hasNextPage: false };
};

export const parseMangaDetails = (html: string, mangaId: string): SourceManga => {
  const $ = load(html);
  const jsonLd = $('script[type="application/ld+json"]')
    .toArray()
    .map((element) => {
      try {
        return JSON.parse($(element).text()) as unknown;
      } catch {
        return undefined;
      }
    })
    .find(
      (entry): entry is Record<string, unknown> =>
        typeof entry === "object" &&
        entry !== null &&
        (entry as Record<string, unknown>)["@type"] === "ComicSeries",
    );
  const record = (jsonLd ?? {}) as Record<string, unknown>;
  const title =
    clean(typeof record.name === "string" ? plainTextFromHtml(record.name) : "") ||
    clean($("h1").first().text());
  if (!title) throw new Error("Rokari series page did not contain a title.");
  const synopsis = clean(
    typeof record.description === "string" ? plainTextFromHtml(record.description) : "",
  );
  const imageUrl =
    resolveHttpsUrl(typeof record.image === "string" ? record.image : undefined, DOMAIN) ??
    resolveHttpsUrl($('meta[property="og:image"]').attr("content"), DOMAIN) ??
    FALLBACK_COVER;
  const genreText = typeof record.genre === "string" ? record.genre : "";
  const genreLinks = $("a[href*='/genres/']")
    .toArray()
    .map((element) => clean($(element).text()))
    .filter(Boolean);
  const genres = [
    ...new Set([
      ...genreText
        .split(",")
        .map((genre) => clean(genre))
        .filter(Boolean),
      ...genreLinks,
    ]),
  ];
  let status: string | undefined;
  $("td").each((_, element) => {
    if (clean($(element).text()).toLowerCase() === "status") {
      const value = clean($(element).next("td").text());
      if (value) status = value;
    }
  });
  return {
    mangaId,
    mangaInfo: {
      primaryTitle: title,
      secondaryTitles: [],
      thumbnailUrl: imageUrl,
      synopsis: synopsis || title,
      contentRating: contentRatingForTags(genres),
      contentType: "comic",
      ...(status && { status }),
      shareUrl: buildMangaUrl(mangaId),
      tagGroups:
        genres.length > 0
          ? [
              {
                id: "genres",
                title: "Genres",
                tags: genres.map((tag) => ({
                  id: encodePaperbackIdComponent(tag),
                  title: tag,
                })),
              },
            ]
          : [],
    },
  };
};

export const parseChapters = (html: string, sourceManga: SourceManga): Chapter[] => {
  const $ = load(html);
  const seen = new Set<string>();
  const chapters: Chapter[] = [];
  $("li[data-num] a[href*='-chapter-']").each((_, element) => {
    const link = $(element);
    const slug = chapterSlugFromHref(link.attr("href"));
    if (!slug || seen.has(slug)) return;
    seen.add(slug);
    const chapterId = encodeSlug(slug);
    if (!chapterId) return;
    const title = clean(link.find(".chapternum").first().text()) || slug;
    const dateText = clean(link.find(".chapterdate").first().text());
    const publishDate = dateText ? new Date(dateText) : undefined;
    const chapNum = chapterNumberFromSlug(slug);
    chapters.push({
      sourceManga,
      chapterId,
      langCode: "en",
      chapNum: Number.isFinite(chapNum) ? chapNum : 0,
      title,
      ...(publishDate && !Number.isNaN(publishDate.getTime()) && { publishDate }),
      additionalInfo: { url: buildChapterUrl(chapterId) },
    });
  });
  if (chapters.length === 0) throw new Error("Rokari returned no chapters from the series page.");
  const sorted = chapters.sort(
    (left, right) => right.chapNum - left.chapNum || left.chapterId.localeCompare(right.chapterId),
  );
  return sorted.map((chapter, sortingIndex) => ({ ...chapter, sortingIndex }));
};

const isReaderImage = (src: string): boolean =>
  /\/wp-content\/uploads\/manga\//i.test(src) && /\.(?:jpe?g|png|webp)(?:$|[?#])/i.test(src);

export const parseChapterDetails = (html: string, chapter: Chapter): ChapterDetails => {
  const $ = load(html);
  const pages = $("img")
    .toArray()
    .map((element) => resolveHttpsUrl($(element).attr("src") ?? "", DOMAIN))
    .filter((url): url is string => typeof url === "string" && isReaderImage(url));
  const unique = [...new Set(pages)];
  if (unique.length === 0) {
    throw new Error(`Rokari chapter ${chapter.chapterId} returned no pages.`);
  }
  return { id: chapter.chapterId, mangaId: chapter.sourceManga.mangaId, pages: unique };
};

export const parseFilterOptions = (html: string): RokariFilterOptions => {
  const $ = load(html);
  const seen = new Set<string>();
  const genres = $("a[href*='/genres/']")
    .toArray()
    .flatMap((element): Tag[] => {
      const link = $(element);
      const slug =
        link
          .attr("href")
          ?.match(/\/genres\/([^/?#]+)/i)?.[1]
          ?.trim()
          .toLowerCase() ?? "";
      const title = clean(link.text());
      if (!slug || !title || seen.has(slug)) return [];
      seen.add(slug);
      return [{ id: slug, title }];
    })
    .sort((left, right) => left.title.localeCompare(right.title));
  return { genres };
};
