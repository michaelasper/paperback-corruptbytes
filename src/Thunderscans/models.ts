import type { ContentRating, JSONObject } from "@paperback/types";

export interface ThunderSearchMetadata extends JSONObject {
  status?: string[];
  type?: string[];
  genres?: Record<string, "included" | "excluded">;
}

export interface ThunderListItem {
  mangaId: string;
  title: string;
  imageUrl: string;
  contentRating: ContentRating;
  subtitle?: string;
  contentType?: "comic" | "novel";
  status?: string;
  rating?: number;
  latestChapterId?: string;
  publishDate?: Date;
}

export interface ParsedListPage {
  items: ThunderListItem[];
  hasNextPage: boolean;
}

export type HomeFeedId = "popular" | "editors" | "latestComics" | "latestNovels";

export interface ParsedHomeFeed {
  items: ThunderListItem[];
  nextPage?: number;
}

export interface ParseChapterListOptions {
  showLocked?: boolean;
}
