import type { ContentRating, JSONObject, Tag } from "@paperback/types";

export interface MgekoSearchMetadata extends JSONObject {
  genres?: Record<string, "included" | "excluded">;
  status?: string[];
  type?: string[];
  tags?: string;
  setChapterCount?: boolean;
  minChapters?: number;
  maxChapters?: number;
  minRating?: number;
  onlyCompleted?: boolean;
  onlyTranslated?: boolean;
  hideOnBreak?: boolean;
}

export interface MgekoPageMetadata extends JSONObject {
  page?: number;
}

export interface MgekoBrowseEnvelope {
  resultsHtml: string;
  page: number;
  pageCount: number;
  totalCount?: number;
}

export interface MgekoCard {
  mangaId: string;
  title: string;
  imageUrl: string;
  contentRating: ContentRating;
  rating?: number;
  views?: number;
  badge?: string;
}

export interface MgekoFilterOptions {
  genres: Tag[];
  statuses: Tag[];
  types: Tag[];
}
