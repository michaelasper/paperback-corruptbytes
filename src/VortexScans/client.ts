import type {
  Chapter,
  PagedResults,
  SearchQuery,
  SearchResultItem,
  SortingOption,
  SourceManga,
  Tag,
} from "@paperback/types";

import type {
  JsonRecord,
  VortexChaptersResponse,
  VortexManga,
  VortexSearchResponse,
} from "./models.js";
import {
  buildApiUrl,
  buildSearchUrl,
  fetchJSON,
  parseSeriesUrl,
  type SearchMetadata,
} from "./network.js";
import { decodeMangaIdentifier, encodeMangaId, parseMangaDetails } from "./parsers.js";

export interface VortexPostDetailsResponse extends JsonRecord {
  post?: VortexManga | null;
}

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown): string | undefined => {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
};

const numericSuffix = (value: string): string | undefined => {
  const match = value.trim().match(/(?:^|@)(\d+)$/);
  return match?.[1];
};

export const fetchGenres = async (): Promise<Tag[]> => {
  const response = await fetchJSON<unknown>({ url: buildApiUrl("genres"), method: "GET" });
  const values = Array.isArray(response)
    ? response
    : isRecord(response) && Array.isArray(response.genres)
      ? response.genres
      : [];

  return values
    .flatMap((value): Tag[] => {
      if (!isRecord(value)) return [];
      const id = text(value.id);
      const title = text(value.name);
      return id && title ? [{ id, title }] : [];
    })
    .sort((left, right) => left.title.localeCompare(right.title));
};

export const fetchSearchPage = async (
  query: SearchQuery<SearchMetadata>,
  sortingOption: SortingOption | undefined,
  page: number,
): Promise<VortexSearchResponse> =>
  fetchJSON<VortexSearchResponse>({
    url: buildSearchUrl(query, sortingOption, page),
    method: "GET",
  });

export const fetchPostDetails = async (mangaId: string): Promise<VortexPostDetailsResponse> => {
  const { slug } = decodeMangaIdentifier(mangaId);
  return fetchJSON<VortexPostDetailsResponse>({
    url: buildApiUrl("post", { postSlug: slug }),
    method: "GET",
  });
};

const postIdFrom = (value: unknown): string | undefined => {
  if (!isRecord(value)) return undefined;
  const post = isRecord(value.post) ? value.post : value;
  return text(post.id ?? post.postId ?? post.mangaId);
};

export const fetchChapterList = async (
  sourceManga: SourceManga,
): Promise<VortexChaptersResponse> => {
  const detailsId = text(sourceManga.mangaInfo.additionalInfo?.id);
  let postId = detailsId ?? numericSuffix(sourceManga.mangaId);

  if (!postId) {
    postId = postIdFrom(await fetchPostDetails(sourceManga.mangaId));
  }
  if (!postId) {
    throw new Error("Vortex Scans did not return the numeric post ID needed for chapters.");
  }

  return fetchJSON<VortexChaptersResponse>({
    url: buildApiUrl("chapters", { postId, take: "all" }),
    method: "GET",
  });
};

export const fetchChapterContent = async (chapter: Chapter): Promise<unknown> => {
  const { slug: decodedMangaSlug } = decodeMangaIdentifier(chapter.sourceManga.mangaId);
  const mangaSlug = chapter.sourceManga.mangaInfo.additionalInfo?.slug ?? decodedMangaSlug;
  const chapterSlug = chapter.additionalInfo?.slug;
  const headers = { "cache-control": "no-store" };

  if (mangaSlug && chapterSlug) {
    return fetchJSON<unknown>({
      url: buildApiUrl("chapter/content", {
        mangaslug: mangaSlug,
        chapterslug: chapterSlug,
      }),
      method: "GET",
      headers,
    });
  }

  const chapterId = numericSuffix(chapter.chapterId) ?? chapter.chapterId;
  return fetchJSON<unknown>({
    url: buildApiUrl("chapter", { chapterId }),
    method: "GET",
    headers,
  });
};

export const resolveUrlQuery = async (
  query: string,
): Promise<PagedResults<SearchResultItem> | undefined> => {
  const slug = parseSeriesUrl(query);
  if (!slug) return undefined;

  try {
    const details = await fetchPostDetails(encodeMangaId(slug));
    const manga = parseMangaDetails(details.post ?? details);
    return {
      items: [
        {
          mangaId: manga.mangaId,
          title: manga.mangaInfo.primaryTitle,
          imageUrl: manga.mangaInfo.thumbnailUrl,
          contentRating: manga.mangaInfo.contentRating,
        },
      ],
    };
  } catch {
    return undefined;
  }
};
