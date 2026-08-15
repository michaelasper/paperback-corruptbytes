import type { JSONObject } from "@paperback/types";

export type NovelDashRouteKind = "comic" | "novel";

export interface NovelDashSite {
  readonly key: string;
  readonly name: string;
  readonly domain: string;
  readonly host: string;
  readonly mediaHost: string;
}

export interface NovelDashSearchMetadata extends JSONObject {
  genres?: Record<string, "included" | "excluded">;
  origins?: string[];
  statuses?: string[];
  types?: string[];
  chapterRangeEnabled?: boolean;
  minimumChapters?: number;
  maximumChapters?: number;
  onSale?: boolean;
}

export interface NovelDashPageMetadata extends JSONObject {
  page?: number;
}

export interface NovelDashGenreReference {
  genre?: {
    slug?: unknown;
  } | null;
}

export interface NovelDashCatalogChapter {
  id?: unknown;
  seriesId?: unknown;
  number?: unknown;
  title?: unknown;
  isLocked?: unknown;
  coinPrice?: unknown;
  createdAt?: unknown;
  publishedAt?: unknown;
  unlockedAt?: unknown;
  isFree?: unknown;
}

export interface NovelDashCatalogSeries {
  id?: unknown;
  slug?: unknown;
  urlSlug?: unknown;
  title?: unknown;
  coverImage?: unknown;
  type?: unknown;
  status?: unknown;
  rating?: unknown;
  isHot?: unknown;
  salePercent?: unknown;
  saleEndsAt?: unknown;
  isMature?: unknown;
  dmcaTakenDown?: unknown;
  genres?: NovelDashGenreReference[] | null;
  chapters?: NovelDashCatalogChapter[] | null;
}

export interface NovelDashCatalogResponse {
  data?: NovelDashCatalogSeries[] | null;
  meta?: {
    total?: unknown;
    page?: unknown;
    limit?: unknown;
    totalPages?: unknown;
    hasMore?: unknown;
  } | null;
}

export interface NovelDashTaxonomyItem {
  id?: unknown;
  name?: unknown;
  slug?: unknown;
}

export interface NovelDashSeriesChapter {
  id?: unknown;
  number?: unknown;
  title?: unknown;
  coverImage?: unknown;
  isLocked?: unknown;
  coinPrice?: unknown;
  viewCount?: unknown;
  likeCount?: unknown;
  publishedAt?: unknown;
  revisedAt?: unknown;
  contentFormat?: unknown;
  hasAccess?: unknown;
}

export interface NovelDashSeriesData {
  id?: unknown;
  title?: unknown;
  slug?: unknown;
  altTitle?: unknown;
  origin?: unknown;
  originalTitle?: unknown;
  aliases?: unknown;
  description?: unknown;
  coverImage?: unknown;
  bannerImage?: unknown;
  status?: unknown;
  type?: unknown;
  rating?: unknown;
  ratingCount?: unknown;
  viewCount?: unknown;
  bookmarkCount?: unknown;
  followerCount?: unknown;
  chapterCount?: unknown;
  updatedAt?: unknown;
  isMature?: unknown;
  genres?: unknown;
  tags?: unknown;
  team?: unknown;
  visibility?: unknown;
}

export interface NovelDashSeriesPage {
  series?: NovelDashSeriesData | null;
  chapters?: NovelDashSeriesChapter[] | null;
  currentPage?: unknown;
  totalPages?: unknown;
  globalFirstChapter?: unknown;
  globalLastChapter?: unknown;
  dmcaTakenDown?: unknown;
}

export interface NovelDashReaderPage {
  id?: unknown;
  pageNumber?: unknown;
  imageUrl?: unknown;
  width?: unknown;
  height?: unknown;
  isEncrypted?: unknown;
  tiles?: unknown;
  hasStrips?: unknown;
  strips?: unknown;
  hasFragments?: unknown;
  fragments?: unknown;
}

export interface NovelDashReaderChapter {
  id?: unknown;
  number?: unknown;
  title?: unknown;
  wordCount?: unknown;
  isLocked?: unknown;
  coinPrice?: unknown;
  content?: unknown;
  preview?: unknown;
  pages?: NovelDashReaderPage[] | null;
}

export interface NovelDashReaderData {
  chapter?: NovelDashReaderChapter | null;
  series?: NovelDashSeriesData | null;
  isUnlocked?: unknown;
  isLocked?: unknown;
  coinPrice?: unknown;
  protectionConfig?: {
    isProtected?: unknown;
    useCanvasRendering?: unknown;
    useTileEncryption?: unknown;
    useFragmentProtection?: unknown;
    useImageScramble?: unknown;
  } | null;
}
