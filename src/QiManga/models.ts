import type { ContentRating, JSONObject, Tag } from "@paperback/types";

export interface QiMangaSearchMetadata extends JSONObject {
  genre?: string;
  status?: string;
  type?: string;
  sort?: string;
}

export interface QiMangaPageMetadata extends JSONObject {
  page?: number;
}

export interface QiMangaCard {
  mangaId: string;
  title: string;
  imageUrl: string;
  contentRating: ContentRating;
  rating?: number;
  status?: string;
  type?: string;
}

export interface QiMangaFilterOptions {
  genres: Tag[];
}

/** Wire shape shared by every Qi Manga series list item. */
export interface QiSeriesItem {
  slug: string;
  title: string;
  cover?: string | null;
  type?: string | null;
  status?: string | null;
  avgRating?: number | null;
  redirectUrl?: string | null;
}

/** Paginated API envelope shared by browse, search, and the latest rail. */
export interface QiSeriesEnvelope {
  data: QiSeriesItem[];
  current?: number | null;
  next?: number | null;
  totalPages?: number | null;
  totalItems?: number | null;
}

export interface QiSeriesDetail extends QiSeriesItem {
  alternativeTitles?: string | null;
  description?: string | null;
  author?: string | null;
  artist?: string | null;
  genres?: { slug?: string | null; name?: string | null }[] | null;
  stats?: { averageRating?: number | null; chapterCount?: number | null } | null;
}

export interface QiChapterItem {
  slug: string;
  number: number;
  title?: string | null;
  isFree?: boolean | null;
  price?: number | null;
  discountedPrice?: number | null;
  requiresPurchase?: boolean | null;
  createdAt?: string | null;
}

export interface QiChapterImage {
  url?: string | null;
  order?: number | null;
}

export interface QiChapterContent {
  slug?: string | null;
  title?: string | null;
  content?: string | null;
  images?: QiChapterImage[] | null;
  isFree?: boolean | null;
  requiresPurchase?: boolean | null;
  requiresAuth?: boolean | null;
  series?: { slug?: string | null } | null;
  createdAt?: string | null;
}
