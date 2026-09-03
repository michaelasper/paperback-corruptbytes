import type { ContentRating, JSONObject, SourceManga, Tag } from "@paperback/types";

export interface RinkoSearchMetadata extends JSONObject {
  genres?: string[];
}

export interface RinkoPageMetadata extends JSONObject {
  page?: number;
}

export interface RinkoCatalogItem {
  mangaId: string;
  slug: string;
  postId: string;
  title: string;
  imageUrl: string;
  genres: string[];
  contentRating: ContentRating;
}

export interface RinkoCatalogPage {
  items: RinkoCatalogItem[];
  page: number;
  pageCount?: number;
  totalCount?: number;
  hasNextPage: boolean;
}

export interface RinkoGenre extends Tag {
  postId: string;
  count: number;
}

export interface RinkoAjaxContext {
  ajaxUrl: string;
  nonce: string;
  comicId: string;
  seriesSlug: string;
  nextOffset: number;
  referer: string;
}

export interface RinkoChapterRow {
  chapterId?: string;
  postId: string;
  slug?: string;
  url?: string;
  chapNum: number;
  siteTitle: string;
  title?: string;
  publishDate?: Date;
  isPublic: boolean;
}

export interface RinkoSeriesDocument {
  manga: SourceManga;
  chapterCount: number;
  initialRows: RinkoChapterRow[];
  ajaxContext?: RinkoAjaxContext;
}
