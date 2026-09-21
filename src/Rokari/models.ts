import type { ContentRating, JSONObject, Tag } from "@paperback/types";

export interface RokariSearchMetadata extends JSONObject {
  genres?: string[];
}

export interface RokariPageMetadata extends JSONObject {
  page?: number;
}

export interface RokariCard {
  mangaId: string;
  title: string;
  imageUrl: string;
  contentRating: ContentRating;
  latestChapter?: string;
}

export interface RokariCatalogPage {
  items: RokariCard[];
  hasNextPage: boolean;
}

export interface RokariFilterOptions {
  genres: Tag[];
}
