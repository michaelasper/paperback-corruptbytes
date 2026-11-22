const COVER_BASE = "https://qdqgxwrdzpxpkvamufqp.supabase.co/storage/v1/object/public/covers";

export const PENGUIN_SERIES_SLUG = "synthetic-novel";
export const PENGUIN_SERIES_TITLE = "Synthetic Novel";

export interface FixtureChapter {
  readonly slug: string;
  readonly number: number;
  readonly title: string;
  /** Omit to model a record whose published access flag is missing. */
  readonly premium?: boolean;
  readonly publishedAt?: string;
}

const flightHtml = (stream: string): string =>
  `<script>self.__next_f.push(${JSON.stringify([1, stream])})</script>`;

const coverUrl = (slug: string): string => `${COVER_BASE}/${slug}.webp`;

export const fixtureParagraphs = (count = 3): string[] =>
  Array.from({ length: count }, (_, index) => `Synthetic paragraph ${index + 1}.`);

export const fixtureChapters = (count = 4, premiumFrom = 4): FixtureChapter[] =>
  Array.from({ length: count }, (_, index) => {
    const number = index + 1;
    return {
      slug: `chapter-${number}-synthetic-part-${number}`,
      number,
      title: `Synthetic Part ${number}`,
      premium: number >= premiumFrom,
      publishedAt: `2026-01-${String(number).padStart(2, "0")}T00:00:00.000Z`,
    };
  });

const cardHtml = (index: number, adult: boolean): string =>
  `<a class="group block" href="/novels/synthetic-series-${index}"><div class="cover relative"><img alt="Synthetic Series ${index}" src="${coverUrl(`synthetic-series-${index}`)}"><div class="badges">${adult ? '<span aria-label="Adult content">18+</span>' : ""}</div></div><h3>Synthetic Series ${index}</h3><p>Fantasy</p></a>`;

const cards = (from: number, count: number, adultEvery = 5): string =>
  Array.from({ length: count }, (_, offset) => {
    const index = from + offset;
    return cardHtml(index, index % adultEvery === 0);
  }).join("\n");

export interface CatalogFixtureOptions {
  readonly page?: number;
  readonly count?: number;
  /** Renders the recommendation rail the site shows beside real results. */
  readonly recommendations?: number;
  readonly emptyState?: boolean;
}

export const catalogHtml = ({
  page = 1,
  count = 60,
  recommendations = 0,
  emptyState = false,
}: CatalogFixtureOptions = {}): string => {
  const nextPage = emptyState || count === 0 || page >= 5 ? undefined : page + 1;
  return `<!DOCTYPE html><html><head><title>All Novels - Penguin Squad</title></head><body><h1>All Novels</h1><form role="search" action="/search"><input type="text" name="q" value=""/></form><div class="mt-6 grid">${emptyState ? "" : cards(page * 100, count)}</div>${emptyState ? '<div class="text-muted-foreground py-24 text-center">No novels match these filters.</div>' : ""}${recommendations > 0 ? `<section class="mt-10"><h2>Popular right now</h2><div class="grid">${cards(900, recommendations)}</div></section>` : ""}${nextPage === undefined ? "" : `<nav><a aria-label="Go to next page" href="/novels?page=${nextPage}">Next</a></nav>`}</body></html>`;
};

export const searchHtml = ({
  term,
  count = 5,
  nextPage,
  recommendations = 0,
  emptyState = false,
}: {
  readonly term: string;
  readonly count?: number;
  readonly nextPage?: number;
  readonly recommendations?: number;
  readonly emptyState?: boolean;
}): string =>
  `<html><head><title>Search - Penguin Squad</title></head><body><form role="search" action="/search"><input type="text" name="q" value="${term}"/></form><div class="results">${emptyState ? "" : cards(200, count)}</div>${emptyState ? `<p class="font-medium">No novels match &quot;${term}&quot;</p>` : ""}${nextPage === undefined ? "" : `<nav><a aria-label="Go to next page" href="/search?page=${nextPage}&amp;q=${encodeURIComponent(term)}">Next</a></nav>`}${recommendations > 0 ? `<section class="mt-10"><h2>Popular right now</h2><div class="grid">${cards(900, recommendations)}</div></section>` : ""}</body></html>`;

export interface SeriesFixtureOptions {
  readonly slug?: string;
  readonly title?: string;
  readonly chapters?: readonly FixtureChapter[];
  readonly premiumCount?: number;
  readonly freeChapterCount?: number;
  readonly canonical?: string;
  readonly bookUrl?: string;
  readonly duplicateArrays?: boolean;
  readonly secondArray?: readonly FixtureChapter[];
  readonly adult?: boolean;
  readonly status?: string;
  readonly genres?: readonly string[];
  readonly includeLinks?: boolean;
  readonly includeCounts?: boolean;
}

export const seriesHtml = ({
  slug = PENGUIN_SERIES_SLUG,
  title = PENGUIN_SERIES_TITLE,
  chapters = fixtureChapters(),
  premiumCount,
  freeChapterCount,
  canonical,
  bookUrl,
  duplicateArrays = true,
  secondArray,
  adult = false,
  status = "Ongoing",
  genres = ["Fantasy", "Romance"],
  includeLinks = true,
  includeCounts = true,
}: SeriesFixtureOptions = {}): string => {
  const rowsFor = (list: readonly FixtureChapter[]): unknown[] =>
    list.map((chapter) => ({
      id: `id-${chapter.slug}`,
      title: chapter.title,
      slug: chapter.slug,
      chapter_number: chapter.number,
      word_count: 2500,
      published_at: chapter.publishedAt ?? null,
      premium: chapter.premium,
      comment_count: 0,
      has_images: false,
    }));
  const rows = rowsFor(chapters);
  const premium = premiumCount ?? chapters.filter((chapter) => chapter.premium).length;
  const free = freeChapterCount ?? chapters.length - premium;
  const seriesUrl = `https://penguin-squad.com/novels/${slug}`;
  const stream = [
    `2e:{"novelSlug":"${slug}","novelTitle":${JSON.stringify(title)},"chapters":${JSON.stringify(rows)}}`,
    ...(includeCounts
      ? [
          `30:{"novelId":"synthetic-id","novelSlug":"${slug}","novelTitle":${JSON.stringify(title)},"premiumCount":${premium},"freeChapterCount":${free}}`,
        ]
      : []),
    ...(duplicateArrays
      ? [
          `5c:{"novelSlug":"${slug}","chapters":${JSON.stringify(rowsFor(secondArray ?? chapters))}}`,
        ]
      : []),
  ].join("\n");
  const blog = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Book",
    name: title,
    url: bookUrl ?? seriesUrl,
    inLanguage: "en",
    author: { "@type": "Person", name: "Synthetic Author" },
    translator: { "@type": "Organization", name: "Synthetic Translator" },
    translationOfWork: { "@type": "Book", name: "합성 원제", inLanguage: "ko" },
    image: coverUrl(slug),
  });
  const chapterLinks = includeLinks
    ? chapters
        .map((chapter) => `<a href="/novels/${slug}/${chapter.slug}">${chapter.title}</a>`)
        .join("\n")
    : "";
  const genreLinks = genres
    .map((genre) => `<a href="/novels?genre=${genre}">${genre}</a>`)
    .join("");
  return `<html><head><title>${title} - Penguin Squad</title><link rel="canonical" href="${canonical ?? seriesUrl}"><meta name="description" content="Synthetic synopsis for parser coverage."><meta property="og:title" content="${title}"><meta property="og:image" content="${coverUrl(slug)}"><script type="application/ld+json">${blog}</script></head><body><div class="grid"><div class="cover"><img alt="${title}" src="${coverUrl(slug)}"></div><div class="min-w-0"><div class="badges">${genreLinks}${adult ? '<span aria-label="Adult content">18+</span>' : ""}<span class="badge">${status}</span></div><h1>${title}</h1></div></div><div class="chapters">${chapterLinks}</div>${flightHtml(stream)}</body></html>`;
};

export interface ChapterFixtureOptions {
  readonly seriesSlug?: string;
  readonly chapterSlug?: string;
  readonly number?: number;
  readonly title?: string;
  readonly paragraphs?: readonly string[];
  readonly gate?: "auth" | "auth-query" | "heading" | "overlay";
  readonly canonical?: string;
  readonly position?: number;
  readonly partOf?: string;
  readonly readerCount?: number;
  readonly notice?: boolean;
  readonly images?: readonly string[];
  readonly flight?: boolean;
}

export const chapterHtml = ({
  seriesSlug = PENGUIN_SERIES_SLUG,
  chapterSlug = "chapter-3-synthetic-part-3",
  number = 3,
  title = "Synthetic Part 3",
  paragraphs = fixtureParagraphs(),
  gate,
  canonical,
  position = number,
  partOf,
  readerCount = 1,
  notice = true,
  images = [],
  flight = true,
}: ChapterFixtureOptions = {}): string => {
  const chapterUrl = `https://penguin-squad.com/novels/${seriesSlug}/${chapterSlug}`;
  const chapterLd = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Chapter",
    name: `Chapter ${number}: ${title}`,
    position,
    url: chapterUrl,
    isPartOf: {
      "@type": "Book",
      name: PENGUIN_SERIES_TITLE,
      url: partOf ?? `https://penguin-squad.com/novels/${seriesSlug}`,
    },
  });
  const reader = `<div class="reader-content">${notice ? '<p class="sr-only">Synthetic rights notice.</p>' : ""}${paragraphs
    .map((paragraph) => `<p class="mb-[1.5em]">${paragraph}</p>`)
    .join("")}${images.map((src) => `<img src="${src}" alt="synthetic">`).join("")}</div>`;
  const gated =
    gate === "overlay"
      ? `<div class="relative max-h-176 overflow-hidden">${reader}</div>`
      : reader.repeat(Math.max(readerCount, 0));
  const gateMarkup =
    gate === "auth"
      ? `<a href="/login?redirect=%2Fnovels%2F${seriesSlug}%2F${chapterSlug}">Sign in</a>`
      : gate === "auth-query"
        ? `<a href="/register?next=%2Fnovels%2F${seriesSlug}%2F${chapterSlug}">Create account</a>`
        : gate === "heading"
          ? "<h2>Unlock this chapter free</h2>"
          : "";
  return `<html><head><title>Chapter ${number}: ${title} | ${PENGUIN_SERIES_TITLE}</title><link rel="canonical" href="${canonical ?? chapterUrl}"><script type="application/ld+json">${chapterLd}</script></head><body>${gateMarkup}${gated}${flight ? flightHtml(`1:null`) : ""}</body></html>`;
};

export const forgedChaptersHtml = (options: SeriesFixtureOptions = {}): string =>
  seriesHtml({ ...options, duplicateArrays: false });
