export const HOME_RESPONSE = {
  banners: [
    {
      id: 1,
      slug: "the-supreme-demon-swordmaster",
      title: "The Supreme Demon Swordmaster",
      cover: "https://media.qimanga.com/file/qiscans/cover.webp",
      type: "MANHWA",
      status: "ONGOING",
      avgRating: 4.1,
      redirectUrl: null,
    },
    {
      id: 2,
      slug: "external-novel",
      title: "External Novel",
      cover: "https://media.qimanga.com/external.webp",
      type: "NOVEL",
      status: "ONGOING",
      avgRating: 5,
      redirectUrl: "https://exnovels.com/series/external-novel",
    },
  ],
  popular: [
    {
      id: 3,
      slug: "eleceed",
      title: "Eleceed",
      cover: "https://media.qimanhwa.com/file/qiscans/eleceed.webp",
      type: "MANHWA",
      status: "ONGOING",
      avgRating: 4.98,
      redirectUrl: "",
    },
  ],
  newSeries: [
    {
      id: 4,
      slug: "new-manga",
      title: "New Manga",
      cover: "https://media.qiscans.org/new.webp",
      type: "MANGA",
      status: "ONGOING",
      avgRating: 0,
      redirectUrl: null,
    },
  ],
  pinned: [
    {
      id: 5,
      slug: "pinned-manhua",
      title: "Pinned Manhua",
      cover: "https://media.ezmanga.org/pinned.webp",
      type: "MANHUA",
      status: "HIATUS",
      avgRating: 3.5,
      redirectUrl: null,
    },
  ],
  editorsPick: [
    {
      id: 6,
      slug: "editors-choice",
      title: "Editor's Choice",
      cover: "https://media.qimanga.com/editors.webp",
      type: "MANHWA",
      status: "COMPLETED",
      avgRating: 4.75,
      redirectUrl: null,
    },
  ],
};

export const LATEST_RESPONSE = {
  data: [HOME_RESPONSE.popular[0], HOME_RESPONSE.newSeries[0]],
  totalItems: 42,
  totalPages: 2,
  current: 1,
  next: 2,
};

export const SEARCH_RESPONSE = {
  data: [HOME_RESPONSE.banners[0]],
  totalItems: 1,
  totalPages: 1,
  current: 1,
  next: null,
};

export const SERIES_DETAIL = {
  id: 1329,
  slug: "the-supreme-demon-swordmaster",
  title: "The Supreme Demon Swordmaster",
  alternativeTitles: "The Strongest Demon Swordsman, 마검지존, The Supreme Demon Swordmaster",
  description:
    "<p>A betrayed warrior returns &amp; takes control.</p><script>steal()</script><p>Second paragraph.</p>",
  cover: "https://media.qimanga.com/file/qiscans/detail.webp",
  type: "MANHWA",
  status: "ONGOING",
  author: "A. Writer",
  artist: "B. Artist",
  redirectUrl: null,
  avgRating: 4.2,
  genres: [
    { id: 2, slug: "action", name: "Action" },
    { id: 42, slug: "ecchi", name: "Ecchi" },
    { id: 2, slug: "action", name: "Action" },
  ],
  stats: {
    averageRating: 4.5,
    ratingCount: 10,
    chapterCount: 4,
  },
};

export const NOVEL_DETAIL = {
  ...SERIES_DETAIL,
  id: 77,
  slug: "i'm-a-soldier-in-america",
  title: "I'm a Soldier in America",
  alternativeTitles: "I Am a Soldier in America",
  type: "NOVEL",
  genres: [{ id: 3, slug: "action", name: "Action" }],
  stats: { averageRating: 4, chapterCount: 72 },
};

export const CHAPTER_PAGE_ONE = {
  data: [
    {
      id: 1,
      slug: "chapter-1",
      number: 1,
      title: "Arrival",
      price: 0,
      discountedPrice: 0,
      isFree: true,
      requiresPurchase: false,
      createdAt: "2026-01-01T12:00:00.000Z",
    },
    {
      id: 2,
      slug: "chapter-2-5",
      number: 2.5,
      title: "A side story",
      price: 50,
      discountedPrice: 25,
      isFree: false,
      requiresPurchase: true,
      createdAt: "2026-01-02T12:00:00.000Z",
    },
  ],
  totalItems: 4,
  totalPages: 2,
  current: 1,
  next: 2,
};

export const CHAPTER_PAGE_TWO = {
  data: [
    {
      id: 3,
      slug: "chapter-3",
      number: 3,
      title: "",
      price: 0,
      discountedPrice: 0,
      isFree: true,
      requiresPurchase: false,
      createdAt: "invalid-date",
    },
    {
      id: 4,
      slug: "chapter-4",
      number: 4,
      title: null,
      price: 50,
      discountedPrice: 50,
      isFree: false,
      requiresPurchase: true,
      createdAt: "2026-01-04T12:00:00.000Z",
    },
  ],
  totalItems: 4,
  totalPages: 2,
  current: 2,
  next: null,
};

export const COMIC_CHAPTER_RESPONSE = {
  id: 3,
  slug: "chapter-3",
  series: { slug: "the-supreme-demon-swordmaster" },
  number: 3,
  title: null,
  content: null,
  isFree: true,
  requiresPurchase: false,
  images: [
    { id: 12, url: "https://media.qimanga.com/pages/02.webp", order: 2 },
    { id: 11, url: "https://media.qimanga.com/pages/01.webp", order: 1 },
    { id: 13, url: "https://media.qimanga.com/pages/02.webp", order: 3 },
  ],
  totalImages: 3,
  createdAt: "2026-01-03T12:00:00.000Z",
};

export const NOVEL_CHAPTER_RESPONSE = {
  id: 32,
  slug: "chapter-32",
  series: { slug: "i'm-a-soldier-in-america" },
  number: 32,
  title: "",
  content:
    '<p>First &amp; safe.</p><script>steal()</script><p onclick="steal()">Second.</p><img src="https://tracker.example/pixel.png"><img src="https://media.qiscans.org/illustration.webp"><a href="javascript:alert(1)">bad link</a><a href="https://evil.example/phish">external</a><a href="#note">note</a>',
  isFree: true,
  requiresPurchase: false,
  images: [],
  totalImages: 0,
};

export const LOCKED_CHAPTER_RESPONSE = {
  id: 52,
  slug: "chapter-52",
  series: { slug: "the-supreme-demon-swordmaster" },
  number: 52,
  title: null,
  content: null,
  price: 50,
  discountedPrice: 50,
  isFree: false,
  requiresPurchase: true,
  images: [],
  totalImages: 0,
};

export const GENRES_RESPONSE = [
  { id: 2, slug: "action", name: "Action" },
  { id: 42, slug: "ecchi", name: "Ecchi" },
  { id: 2, slug: "action", name: "Action duplicate" },
  { id: 9, slug: "adventure-589", name: "Adventure" },
  { id: 10, slug: "", name: "Broken" },
];
