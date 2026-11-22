import type { JSONObject } from "@paperback/types";

export type SeriesId = string & { readonly __penguinSeriesId: unique symbol };
export type ChapterId = string & { readonly __penguinChapterId: unique symbol };

/**
 * What the current anonymous session may read. `unknown` exists so a record
 * whose access cannot be proven stays visible but unreadable.
 */
export type ChapterAccess =
  | { readonly kind: "public" }
  | { readonly kind: "locked" }
  | { readonly kind: "unknown" };

export interface PenguinChapter {
  readonly chapterId: ChapterId;
  readonly number: number;
  readonly title: string;
  readonly publishedAt?: Date;
  readonly access: ChapterAccess;
}

export interface PenguinCard {
  readonly seriesId: SeriesId;
  readonly title: string;
  readonly coverUrl?: string;
  readonly genre?: string;
  readonly adult: boolean;
}

export interface PenguinSeries {
  readonly seriesId: SeriesId;
  readonly title: string;
  readonly synopsis: string;
  readonly authors: readonly string[];
  readonly translator?: string;
  readonly originalTitle?: string;
  readonly tags: readonly string[];
  readonly status?: string;
  readonly coverUrl?: string;
  readonly adult: boolean;
  readonly chapters: readonly PenguinChapter[];
}

export interface PenguinCatalogPage {
  readonly items: readonly PenguinCard[];
  readonly next?: number;
}

export interface PenguinPageMetadata extends JSONObject {
  page?: number;
  query?: string;
}

export interface PenguinReader {
  readonly seriesId: SeriesId;
  readonly chapterId: ChapterId;
  readonly html: string;
}

export type PenguinChapterRef = {
  readonly seriesId: SeriesId;
  readonly chapterId: ChapterId;
};

/** Raised when Penguin Squad does not publish the requested chapter for anonymous readers. */
export class PenguinAccessError extends Error {
  readonly reason: "locked" | "unknown";

  constructor(reason: "locked" | "unknown") {
    super(
      reason === "locked"
        ? "This chapter is premium on Penguin Squad."
        : "Penguin Squad did not report readable access for this chapter.",
    );
    this.name = "PenguinAccessError";
    this.reason = reason;
  }
}
