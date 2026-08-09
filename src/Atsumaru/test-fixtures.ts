/**
 * Small, public-contract fixtures used by the pure Atsumaru parser tests.
 *
 * These intentionally use opaque IDs instead of title slugs.  Keeping the
 * fixtures as values rather than JSON strings also exercises the unknown
 * boundary that the production parser receives after JSON decoding.
 */

export const AVAILABLE_FILTERS_RESPONSE = {
  genres: [
    { id: "12", name: "Action" },
    { id: "12", name: "Action (duplicate)" },
    { id: "4", name: "Drama" },
  ],
  statuses: [
    { id: "2", name: "Ongoing" },
    { id: "1", name: "Completed" },
  ],
  tags: [
    { id: "safe", name: "Adventure", namePath: "Genres/Adventure", group: "Genres" },
    { id: "adult", name: "Erotica", namePath: "Adult/Erotica", group: "Adult" },
    { id: "safe", name: "Duplicate ID", namePath: "Genres/Duplicate", group: "Genres" },
  ],
  types: [
    { id: "Manga", name: "Manga" },
    { id: "Manwha", name: "Manwha" },
  ],
};

export const SEARCH_RESPONSE = {
  found: 3,
  page: 2,
  per_page: 1,
  hits: [
    {
      document: {
        id: "7nZTg",
        title: "Safe Archive",
        englishTitle: "Safe Archive",
        poster: { mediumImage: "/static/posters/7nZTg-medium.webp" },
        type: "Manga",
        medium: "Comic",
        isAdult: false,
        status: "Completed",
        year: 2022,
        mbRating: 8.2,
        mbContentRating: "safe",
        views: "1,234",
        releaseDate: 1654041600000,
        chapterCount: 4,
        officialTranslation: true,
      },
    },
    {
      document: {
        id: "lwT7",
        title: "Suggestive Notes",
        englishTitle: "",
        poster: { largeImage: "https://atsu.moe/static/posters/lwT7.webp" },
        type: "Manwha",
        medium: "Comic",
        isAdult: false,
        status: "Ongoing",
        year: 2024,
        mbRating: "7.5",
        mbContentRating: "suggestive",
        views: "42",
        releaseDate: 1704067200000,
        chapterCount: 1,
      },
    },
    {
      document: {
        id: "68Fv",
        title: "Adult Novel",
        poster: { image: "/pages/not-a-poster.webp" },
        type: "Manga",
        medium: "Novel",
        isAdult: true,
        status: "Ongoing",
        year: 2023,
        mbRating: 5,
        mbContentRating: "adult",
        views: "9",
        releaseDate: 1688169600000,
        chapterCount: 2,
      },
    },
    // Missing ID/title must be skipped, not repaired from a slug or image.
    { document: { title: "Not a result", poster: { image: "/static/posters/unknown.webp" } } },
  ],
};

export const FEED_RESPONSE = {
  items: [
    {
      id: "oJQ4o",
      title: "Feed Comic",
      image: "/static/posters/oJQ4o.webp",
      smallImage: "static/posters/oJQ4o-small.webp",
      mediumImage: "posters/oJQ4o-medium.webp",
      largeImage: "https://cdN.atsu.moe/static/posters/oJQ4o-large.webp",
      isAdult: false,
      type: "Manga",
      medium: "Comic",
      mbRating: 8,
      views: "100",
    },
    {
      id: "N7JpR",
      title: "Feed Novel",
      image: "https://atsu.moe/static/posters/N7JpR.webp",
      isAdult: true,
      type: "Manga",
      medium: "Novel",
      mbRating: "6.5",
      mbContentRating: "adult",
      views: "5",
    },
    { id: "missing-title" },
  ],
};

export const MANGA_PAGE_RESPONSE = {
  mangaPage: {
    id: "oJQ4o",
    title: "Archive Hero",
    englishTitle: "Archive Hero",
    otherNames: ["Archive Hero", "Архивный герой", ""],
    synopsis: "<p>A plain <strong>description</strong>.</p><script>bad()</script>",
    type: "Manga",
    medium: "Comic",
    status: "Completed",
    isAdult: false,
    released: 1609459200000,
    avgRating: 8.75,
    views: "10,000",
    totalChapterCount: 3,
    poster: {
      image: "/static/posters/oJQ4o-small.webp",
      smallImage: "static/posters/oJQ4o-small.webp",
      mediumImage: "posters/oJQ4o-medium.webp",
      largeImage: "https://atsu.moe/static/posters/oJQ4o-large.webp",
    },
    banner: { url: "banners/oJQ4o.webp" },
    genres: [
      { id: "genre-action", name: "Action", weight: 1 },
      { id: "genre-drama", name: "Drama", weight: 0.4 },
    ],
    tags: [
      { id: "tag-romance", name: "Romance", namePath: "Themes/Romance", weight: 0.9 },
      { id: "tag-gore", name: "Gore", namePath: "Content/Gore", weight: 0.2 },
      { id: "tag-gore", name: "Gore duplicate", namePath: "Content/Gore", weight: 0.1 },
    ],
    authors: [
      { id: "author-1", name: "Jane Doe", type: "Author" },
      { id: "artist-1", name: "John Doe", type: "Artist" },
      { id: "unknown", name: "Unknown", type: "Other" },
    ],
    scanlators: [
      { id: "scan-manga-oJQ4o", name: "Archive Team" },
      { id: "scan-manga-second", name: "Second Team" },
    ],
  },
};

export const CHAPTERS_RESPONSE = {
  chapters: [
    {
      id: "wZieNneB",
      scanlationMangaId: "scan-manga-oJQ4o",
      title: "Chapter 2 — The return {extra}",
      number: 2,
      createdAt: 1700000000000,
      index: 1,
      pageCount: 5,
      progress: 1,
    },
    {
      id: "h4j-gl",
      scanlationMangaId: "scan-manga-oJQ4o",
      title: "Chapter 1",
      number: 1,
      createdAt: 1690000000000,
      index: 0,
      pageCount: 3,
      progress: 1,
    },
    {
      id: "_rmrsb",
      scanlationMangaId: "scan-manga-oJQ4o",
      title: "Chapter 2 — Alternate",
      number: 2,
      createdAt: 1700000001000,
      index: 2,
      pageCount: 6,
      progress: 1,
    },
    // Exact duplicate ID: deterministic first record wins.
    {
      id: "_rmrsb",
      scanlationMangaId: "scan-manga-oJQ4o",
      title: "Chapter 2 — Alternate",
      number: 2,
      createdAt: 1700000001000,
      index: 2,
      pageCount: 6,
      progress: 1,
    },
    {
      id: "-5gIlu",
      scanlationMangaId: "scan-manga-oJQ4o",
      title: "Chapter 3",
      number: 3,
      createdAt: 1710000000000,
      index: 4,
      pageCount: 2,
      progress: 1,
    },
    {
      id: "-5gIlu",
      scanlationMangaId: "scan-manga-oJQ4o",
      title: "Chapter 3 conflicting",
      number: 3,
      createdAt: 1710000001000,
      index: 5,
      pageCount: 2,
      progress: 1,
    },
    // Missing ID/title is malformed and must be skipped.
    { scanlationMangaId: "scan-manga-oJQ4o", number: 9 },
  ],
};

export const COMIC_CHAPTER_RESPONSE = {
  readChapter: {
    id: "wZieNneB",
    title: "Chapter 2",
    scanlationMangaId: "scan-manga-oJQ4o",
    pages: [
      { id: "p2", image: "pages/2.webp", number: 2, width: 100, height: 200, aspectRatio: 0.5 },
      {
        id: "p1",
        image: "/static/pages/1.webp",
        number: 1,
        width: 100,
        height: 200,
        aspectRatio: 0.5,
      },
      {
        id: "p1-copy",
        image: "/static/pages/1.webp",
        number: 1,
        width: 100,
        height: 200,
        aspectRatio: 0.5,
      },
      { id: "foreign", image: "https://example.com/pages/3.webp", number: 3 },
      { id: "javascript", image: "javascript:alert(1)", number: 4 },
      { id: "traversal", image: "/static/../secret.webp", number: 5 },
    ],
  },
};

export const NOVEL_CHAPTER_RESPONSE = {
  readNovelChapter: {
    id: "zFL0iqq",
    title: "Chapter 5",
    number: 5,
    scanlationMangaId: "scan-manga-N7JpR",
    paragraphs: ["<script>steal()</script>Hello & goodbye", "  Second paragraph  "],
    wordCount: 4,
  },
};
