import type { ContentRating, JSONObject, Tag } from "@paperback/types";

export type MadaraAdultFilter = "all" | "none" | "only";
export type MadaraGenreCondition = "or" | "and";

export interface MadaraSearchMetadata extends JSONObject {
  genres?: string[];
  genreCondition?: MadaraGenreCondition;
  author?: string;
  artist?: string;
  release?: string;
  adult?: MadaraAdultFilter;
  status?: string[];
}

export interface MadaraPageMetadata extends JSONObject {
  page?: number;
}

export interface MadaraCard {
  mangaId: string;
  title: string;
  imageUrl: string;
  contentRating: ContentRating;
  rating?: number;
  latestChapterId?: string;
  latestChapterTitle?: string;
}

export interface MadaraCatalogPage {
  items: MadaraCard[];
  hasNextPage: boolean;
}

export interface MadaraFilterOptions {
  genres: Tag[];
  statuses: Tag[];
}
