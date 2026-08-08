import type { ContentRating } from "@paperback/types";

export type JsonRecord = Record<string, unknown>;

export interface VortexGenre {
  id?: number | string | null;
  name: string;
  color?: string | null;
}

export interface VortexChapter {
  id: number | string;
  slug?: string | null;
  number: number | string;
  title?: string | null;
  unlockAt?: string | number | null;
  createdAt?: string | number | null;
  updatedAt?: string | number | null;
  chapterStatus?: string | null;
  price?: number | string | null;
  finalPrice?: number | string | null;
  isLocked?: boolean | null;
  isTimeLocked?: boolean | null;
  isPermanentlyLocked?: boolean | null;
  isLockedByCoins?: boolean | null;
  isShortLinkLocked?: boolean | null;
  chapterPurchased?: boolean | null;
  isPurchased?: boolean | null;
  hasPurchased?: boolean | null;
  isAccessible?: boolean | null;
  featuredImage?: string | null;
  mangaPostId?: number | string | null;
  mangaPost?: JsonRecord | null;
  content?: string | null;
  html?: string | null;
  novelContent?: string | null;
  chapterContent?: string | null;
  pages?: unknown;
  images?: unknown;
  pageImages?: unknown;
  [key: string]: unknown;
}

export interface VortexManga {
  id?: number | string | null;
  slug: string;
  postTitle: string;
  postContent?: string | null;
  description?: string | null;
  synopsis?: string | null;
  featuredImage?: string | null;
  cover?: string | null;
  coverUrl?: string | null;
  alternativeTitles?: string | string[] | null;
  author?: string | null;
  artist?: string | null;
  seriesType?: string | null;
  seriesStatus?: string | null;
  contentRating?: string | ContentRating | null;
  releaseDate?: string | number | null;
  createdAt?: string | number | null;
  updatedAt?: string | number | null;
  lastChapterAddedAt?: string | number | null;
  averageRating?: number | string | null;
  genres?: VortexGenre[] | null;
  chapters?: VortexChapter[] | null;
  [key: string]: unknown;
}

export interface VortexSearchResponse {
  posts?: VortexManga[] | null;
  data?: VortexManga[] | null;
  results?: VortexManga[] | null;
  totalCount?: number;
  searchTerm?: string | null;
  [key: string]: unknown;
}

export interface VortexChaptersResponse {
  post?: {
    chapters?: VortexChapter[] | null;
    [key: string]: unknown;
  } | null;
  chapters?: VortexChapter[] | null;
  data?: VortexChapter[] | null;
  [key: string]: unknown;
}

export interface VortexChapterDetailsResponse {
  chapter?: VortexChapter | null;
  data?: VortexChapter | null;
  [key: string]: unknown;
}

export interface MangaListItem {
  mangaId: string;
  title: string;
  imageUrl: string;
  subtitle?: string;
  contentRating: ContentRating;
  contentType?: "comic" | "novel";
  status?: string;
  author?: string;
  artist?: string;
  rating?: number;
  latestChapterId?: string;
  publishDate?: Date;
}

export interface ChapterAccess {
  isLocked: boolean;
  isTimeLocked: boolean;
  isPermanentlyLocked: boolean;
  isLockedByCoins: boolean;
  isShortLinkLocked: boolean;
  price: number;
  chapterPurchased: boolean;
  isPurchased: boolean;
  hasPurchased: boolean;
  isAccessible: boolean;
  unlockAt?: Date;
}

export interface ParseChapterListOptions {
  /** Keep inaccessible chapters in the list. Defaults to true. */
  showLocked?: boolean;
  /** Language marker used by Paperback. Defaults to `en`. */
  langCode?: string;
}
