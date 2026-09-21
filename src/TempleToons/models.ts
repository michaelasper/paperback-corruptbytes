import type { ContentRating, JSONObject, Tag } from "@paperback/types";

export interface TempleSearchMetadata extends JSONObject {
  status?: string[];
}

export interface TemplePageMetadata extends JSONObject {
  page?: number;
}

export interface TempleCard {
  mangaId: string;
  title: string;
  imageUrl: string;
  contentRating: ContentRating;
  subtitle?: string;
}

export interface TempleCatalogPage {
  items: TempleCard[];
  hasNextPage: boolean;
}

export interface TempleFilterOptions {
  statuses: Tag[];
}
