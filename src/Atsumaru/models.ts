import type { ContentRating, JSONObject, Tag } from "@paperback/types";

/** Tri-state taxonomy selection used by the explore form. */
export type AtsumaruTaxonomyState = "included" | "excluded";

/**
 * The audience switch used by Atsumaru's home and explore APIs. `safe` is the
 * legacy internal ID for the user-facing Standard catalog.
 */
export type AtsumaruAdultPolicy = "all" | "safe" | "adult" | "only";

/** A release-year interval. Both ends are inclusive when sent to Typesense. */
export interface AtsumaruYearRange extends JSONObject {
  from?: number;
  to?: number;
  min?: number;
  max?: number;
}

/**
 * Stable metadata kept in Paperback search queries.
 *
 * The API calls these values genres/tags and uses IDs rather than names. The
 * record form deliberately retains the tri-state values so callers can carry
 * an advanced-search form through a round trip without losing exclusions.
 */
export interface AtsumaruSearchMetadata extends JSONObject {
  genres?: Record<string, AtsumaruTaxonomyState>;
  tags?: Record<string, AtsumaruTaxonomyState>;
  excludeGenres?: string[];
  excludeTags?: string[];
  types?: string[];
  mediums?: string[];
  statuses?: string[];
  contentRatings?: string[];
  adult?: AtsumaruAdultPolicy;
  adultPolicy?: AtsumaruAdultPolicy;
  yearFrom?: number;
  yearTo?: number;
  releaseYearFrom?: number;
  releaseYearTo?: number;
  years?: number[];
  yearRange?: AtsumaruYearRange;
  minChapters?: number;
  officialTranslation?: boolean;
  /** A source sort ID; kept here for callers that store the whole filter. */
  sortBy?: string;
}

/** Metadata used to persist either one-based search pages or home offsets. */
export interface AtsumaruPageMetadata extends JSONObject {
  page?: number;
  offset?: number;
}

/** A normalized available taxonomy item. */
export interface AtsumaruTaxonomy extends JSONObject {
  id: string;
  name: string;
  title?: string;
  group?: string;
  adult?: boolean;
  safeCount?: number;
  adultCount?: number;
}

/** Alias retained for code that distinguishes tags from genre taxonomy. */
export interface AtsumaruTag extends AtsumaruTaxonomy {}

/** A grouped tag collection returned by availableFilters. */
export interface AtsumaruTagGroup extends JSONObject {
  id: string;
  name: string;
  tags: AtsumaruTag[];
}

/** Complete available filter taxonomy. */
export interface AtsumaruFilterOptions extends JSONObject {
  genres: AtsumaruTaxonomy[];
  tags: AtsumaruTag[];
  tagGroups?: AtsumaruTagGroup[];
  types: AtsumaruTaxonomy[];
  mediums?: AtsumaruTaxonomy[];
  statuses: AtsumaruTaxonomy[];
  contentRatings?: AtsumaruTaxonomy[];
}

export interface AtsumaruDiscoveryPreferences extends JSONObject {
  /** `safe` is retained as the persisted ID for the Standard catalog. */
  catalog?: "safe" | "adult";
  offset?: number;
  limit?: number;
  adult?: boolean;
  types?: string[];
  mediums?: string[];
  includedTags?: string[];
  excludedTags?: string[];
  timeframe?: AtsumaruTimeframe;
  popularTimeframe?: AtsumaruTimeframe;
  bookmarksTimeframe?: AtsumaruTimeframe;
  talkedAboutTimeframe?: AtsumaruTimeframe;
  genre?: string;
  genreId?: string;
  genreSpotlight?: string;
}

export type AtsumaruTimeframe = "daily" | "weekly" | "monthly" | "all";

export type AtsumaruHomeFeed =
  | "hotUpdates"
  | "recentlyUpdated"
  | "popular"
  | "rising"
  | "hotArrivals"
  | "mostBookmarked"
  | "genreSpotlight"
  | "mostTalkedAbout"
  | "recentlyAdded"
  | "bingeWorthy"
  | "mostPolarizing"
  | "hiddenGems"
  | "topRated";

/** The fields shared by Typesense and /api/home2 card records. */
export interface AtsumaruCard extends JSONObject {
  mangaId: string;
  title: string;
  imageUrl: string;
  contentRating: ContentRating;
  contentType?: string;
  type?: string;
  medium?: string;
  isAdult?: boolean;
  status?: string;
  year?: number;
  rating?: number;
  views?: number;
  chapterCount?: number;
  officialTranslation?: boolean;
  latestChapterId?: string;
  latestChapterTitle?: string;
}

export interface AtsumaruCatalogPage extends JSONObject {
  items: AtsumaruCard[];
  hasNextPage?: boolean;
  page?: number;
  offset?: number;
  /** Next raw API offset; may exceed items.length when malformed cards are skipped. */
  nextOffset?: number;
  totalCount?: number;
}

export interface AtsumaruSearchPage extends AtsumaruCatalogPage {
  page: number;
  totalCount: number;
  hasNextPage: boolean;
}

export interface AtsumaruHomePage extends JSONObject {
  items: AtsumaruCard[];
  offset?: number;
  hasNextPage?: boolean;
}

/** Raw response envelopes are intentionally permissive; parsers validate fields. */
export interface AtsumaruSearchEnvelope extends JSONObject {
  found?: number;
  page?: number;
  hits?: JSONObject[];
  success?: boolean;
  error?: string;
}

export interface AtsumaruFeedEnvelope extends JSONObject {
  items?: JSONObject[];
  success?: boolean;
  error?: string;
}

export interface AtsumaruMangaPageEnvelope extends JSONObject {
  mangaPage?: JSONObject;
  success?: boolean;
  error?: string;
}

export interface AtsumaruChaptersEnvelope extends JSONObject {
  chapters?: JSONObject[];
  success?: boolean;
  error?: string;
}

export interface AtsumaruReadEnvelope extends JSONObject {
  readChapter?: JSONObject;
  readNovelChapter?: JSONObject;
  success?: boolean;
  error?: string;
}

/** Re-export the Paperback taxonomy shape for adapters that need a UI Tag. */
export type AtsumaruPaperbackTag = Tag;
