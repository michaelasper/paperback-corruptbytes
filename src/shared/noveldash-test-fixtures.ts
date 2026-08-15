import { ContentRating, type SourceManga } from "@paperback/types";

import type { NovelDashSeriesChapter, NovelDashSite } from "./noveldash-models.js";
import { encodeNovelDashMangaId } from "./noveldash-network.js";

export const NOVELDASH_TEST_SITE = {
  key: "fixture_scans",
  name: "Fixture Scans",
  domain: "https://fixture.example",
  host: "fixture.example",
  mediaHost: "media.fixture.example",
} as const satisfies NovelDashSite;

export const COMIC_MANGA_ID = encodeNovelDashMangaId("comic", "route-slug");
export const NOVEL_MANGA_ID = encodeNovelDashMangaId("novel", "novel-route");

const safeScriptJson = (value: unknown): string => JSON.stringify(value).replace(/</g, "\\u003c");

export const flightHtml = (chunks: readonly string[], head = ""): string =>
  `<!doctype html><html><head>${head}</head><body>${chunks
    .map((chunk) => `<script>self.__next_f.push(${safeScriptJson([1, chunk])})</script>`)
    .join("")}</body></html>`;

const textBytes = (value: string): number => new TextEncoder().encode(value).byteLength;

export const textRecordChunks = (id: string, value: string): string[] => [
  `${id}:T${textBytes(value).toString(16)},`,
  value,
];

export const seriesChapter = (
  number: number,
  overrides: Partial<NovelDashSeriesChapter> = {},
): NovelDashSeriesChapter => ({
  id: `chapter-${number}`,
  number,
  title: `Chapter ${number}`,
  isLocked: false,
  coinPrice: 0,
  publishedAt: new Date(Date.UTC(2026, 0, Math.min(number, 28))).toISOString(),
  contentFormat: "IMAGES",
  hasAccess: true,
  ...overrides,
});

interface SeriesPageFixtureOptions {
  page?: number;
  totalPages?: number;
  chapterCount?: number;
  chapters?: NovelDashSeriesChapter[];
  kind?: "comic" | "novel";
  description?: string;
}

export const seriesPageHtml = (options: SeriesPageFixtureOptions = {}): string => {
  const page = options.page ?? 1;
  const kind = options.kind ?? "comic";
  const description = options.description ?? "A fixture synopsis.";
  const descriptionReference = "60";
  const data = {
    series: {
      id: "series-upstream-id",
      title: kind === "comic" ? "Fixture Comic" : "Fixture Novel",
      slug: kind === "comic" ? "reader-slug" : "misleading-reader-slug",
      altTitle: "Fixture Alternate",
      originalTitle: "Fixture Original",
      aliases: ["Fixture Comic", "Fixture Alias"],
      description: `$${descriptionReference}`,
      coverImage: "/uploads/series/cover.webp",
      bannerImage: "/uploads/series/banner.webp",
      status: "ONGOING",
      type: kind === "comic" ? "MANHWA" : "WEB_NOVEL",
      rating: 8.5,
      chapterCount: options.chapterCount ?? options.chapters?.length ?? 2,
      origin: "KOREAN",
      genres: [
        { name: "Fantasy", slug: "fantasy" },
        { name: "Adult", slug: "adult" },
        { name: "Slice of Life", slug: "slice-of-life" },
      ],
      tags: [
        { name: "Time Travel", slug: "time-travel" },
        { name: "School Life", slug: "school-life" },
      ],
      team: { name: "Fixture Team" },
    },
    chapters: options.chapters ?? [
      seriesChapter(1),
      seriesChapter(2, {
        title: "A paid chapter",
        isLocked: true,
        coinPrice: 50,
        hasAccess: false,
      }),
    ],
    currentPage: page,
    totalPages: options.totalPages ?? 1,
  };
  const schema = safeScriptJson({
    "@context": "https://schema.org",
    "@type": "Book",
    name: data.series.title,
    author: { "@type": "Person", name: "Fixture Author" },
    description,
  });
  return flightHtml(
    [...textRecordChunks(descriptionReference, description), `19:${safeScriptJson(data)}\n`],
    `<script type="application/ld+json">${schema}</script>`,
  );
};

const comicReaderFixture = (
  protection: "active" | "dormant" | "none",
  purchased = false,
): string => {
  const hasProtectionMetadata = protection !== "none";
  return flightHtml([
    `1c:${safeScriptJson({
      chapter: {
        id: "chapter-1",
        number: 1,
        title: "Chapter 1",
        isLocked: purchased,
        coinPrice: purchased ? 50 : 0,
        content: "",
        pages: [
          {
            id: "page-2",
            pageNumber: 2,
            imageUrl: "https://media.fixture.example/series/route-slug/0001/page-2.webp",
            isEncrypted: hasProtectionMetadata,
            tiles: hasProtectionMetadata
              ? [{ index: 0, x: 0, y: 0, width: 512, height: 512, iv: "fixture" }]
              : [],
            hasStrips: hasProtectionMetadata,
            strips: hasProtectionMetadata ? [{ startY: 0, endY: 100 }] : [],
            hasFragments: false,
            fragments: [],
          },
          {
            id: "page-1",
            pageNumber: 1,
            imageUrl: "https://media.fixture.example/series/route-slug/0001/page-1.webp",
            isEncrypted: false,
            tiles: [],
            hasStrips: false,
            strips: [],
            hasFragments: false,
            fragments: [],
          },
        ],
      },
      isUnlocked: true,
      isLocked: purchased,
      coinPrice: purchased ? 50 : 0,
      protectionConfig: {
        isProtected: protection === "active",
        useCanvasRendering: false,
        useTileEncryption: protection === "active",
        useFragmentProtection: false,
        useImageScramble: false,
      },
    })}\n`,
  ]);
};

export const comicReaderHtml = comicReaderFixture("none");
export const dormantProtectionComicReaderHtml = comicReaderFixture("dormant");
export const purchasedComicReaderHtml = comicReaderFixture("none", true);
export const protectedComicReaderHtml = comicReaderFixture("active");

export const lockedReaderHtml = flightHtml([
  `1c:${safeScriptJson({
    chapter: {
      id: "chapter-2",
      number: 2,
      title: "A paid chapter",
      isLocked: true,
      coinPrice: 50,
      content: "",
      pages: [
        {
          id: "page-1",
          pageNumber: 1,
          imageUrl: "https://media.fixture.example/series/route-slug/0002/locked.webp",
        },
      ],
    },
    isUnlocked: false,
    isLocked: true,
    coinPrice: 50,
  })}\n`,
]);

export const novelReaderHtml = (content: string): string =>
  flightHtml([
    ...textRecordChunks("68", content),
    `1c:${safeScriptJson({
      chapter: {
        id: "novel-chapter-1",
        number: 1,
        title: "Novel chapter",
        isLocked: false,
        coinPrice: 0,
        content: "$68",
        pages: [],
      },
      isUnlocked: true,
      isLocked: false,
    })}\n`,
  ]);

export const taxonomyHtml = flightHtml([
  `10:${safeScriptJson({
    genres: [
      { id: "1", name: "Drama", slug: "drama" },
      { id: "2", name: "Adult", slug: "adult" },
      { id: "3", name: "Fantasy", slug: "fantasy" },
    ],
    initialSeries: [{ genres: [{ genre: { slug: "drama" } }] }],
  })}\n`,
]);

export const sourceMangaFixture = (kind: "comic" | "novel" = "comic"): SourceManga => ({
  mangaId: kind === "comic" ? COMIC_MANGA_ID : NOVEL_MANGA_ID,
  mangaInfo: {
    primaryTitle: kind === "comic" ? "Fixture Comic" : "Fixture Novel",
    secondaryTitles: [],
    thumbnailUrl: "https://media.fixture.example/cover.webp",
    synopsis: "Fixture",
    contentRating: ContentRating.ADULT,
    contentType: kind,
  },
});
