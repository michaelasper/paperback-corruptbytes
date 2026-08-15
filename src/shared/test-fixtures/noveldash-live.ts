import assert from "node:assert/strict";

import type {
  Chapter,
  ChapterDetails,
  Request,
  Response as PaperbackResponse,
  SourceManga,
} from "@paperback/types";

import { fetchNovelDashAccountStatus } from "../noveldash-auth.js";
import { NovelDashClient } from "../noveldash-client.js";
import type { NovelDashRouteKind, NovelDashSite } from "../noveldash-models.js";
import { encodeNovelDashMangaId } from "../noveldash-network.js";

const USER_AGENT = "Mozilla/5.0 PaperbackExtensionLiveContract/1.0";
const REQUEST_TIMEOUT_MS = 30_000;

export interface NovelDashLiveSeries {
  kind: NovelDashRouteKind;
  slug: string;
  title: string;
  minimumChapters?: number;
  internalSlug?: string;
  readableAfterChapter?: number;
}

const headersFrom = (headers: Headers): Record<string, string> =>
  Object.fromEntries(headers.entries());

export const installNovelDashLiveApplication = (enabled: boolean): (() => void) => {
  const originalApplication = globalThis.Application;
  if (enabled) {
    Object.assign(globalThis, {
      Application: {
        arrayBufferToUTF8String: (buffer: ArrayBuffer): string => new TextDecoder().decode(buffer),
        scheduleRequest: async (request: Request): Promise<[PaperbackResponse, ArrayBuffer]> => {
          const headers = new Headers(request.headers);
          headers.set("user-agent", USER_AGENT);
          const response = await fetch(request.url, {
            method: request.method ?? "GET",
            headers,
            body: typeof request.body === "string" ? request.body : undefined,
            redirect: "follow",
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          });
          return [
            {
              url: response.url,
              status: response.status,
              headers: headersFrom(response.headers),
              cookies: [],
            },
            await response.arrayBuffer(),
          ];
        },
      },
    });
  }
  return () => {
    if (enabled) Object.assign(globalThis, { Application: originalApplication });
  };
};

const validateManga = (manga: SourceManga, expectedTitle: string): void => {
  assert.equal(manga.mangaInfo.primaryTitle, expectedTitle);
  assert.match(manga.mangaInfo.thumbnailUrl, /^https:\/\//);
  assert.ok(manga.mangaInfo.synopsis.length > 0);
};

const validateChapterList = (manga: SourceManga, chapters: Chapter[]): void => {
  assert.ok(chapters.length > 0, `${manga.mangaInfo.primaryTitle} returned no chapters.`);
  assert.equal(new Set(chapters.map((chapter) => chapter.chapterId)).size, chapters.length);
  for (const [index, chapter] of chapters.entries()) {
    assert.equal(chapter.sourceManga.mangaId, manga.mangaId);
    assert.equal(chapter.sortingIndex, index);
    assert.ok(Number.isFinite(chapter.chapNum));
  }
};

const validateReader = async (
  site: NovelDashSite,
  kind: NovelDashRouteKind,
  chapter: Chapter,
  details: ChapterDetails,
): Promise<void> => {
  if (kind === "comic") {
    assert.ok("pages" in details, `${chapter.chapterId} did not return a comic reader.`);
    if (!("pages" in details)) return;
    assert.ok(details.pages.length > 0);
    assert.ok(details.pages.every((page) => page.startsWith("https://")));

    const response = await fetch(details.pages[0]!, {
      headers: { referer: `${site.domain}/`, "user-agent": USER_AGENT },
      redirect: "follow",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    assert.equal(response.ok, true, `Comic page returned HTTP ${response.status}.`);
    assert.match(response.headers.get("content-type") ?? "", /^image\//i);
    return;
  }

  assert.equal(details.type, "html");
  if (details.type !== "html") return;
  assert.ok(details.html.length > 100);
  assert.doesNotMatch(details.html, /<(?:script|iframe|form)\b/i);
};

const loadSeries = async (
  site: NovelDashSite,
  series: NovelDashLiveSeries,
): Promise<{ chapters: Chapter[]; client: NovelDashClient; manga: SourceManga }> => {
  const client = new NovelDashClient(site);
  const mangaId = encodeNovelDashMangaId(series.kind, series.slug);
  const manga = await client.getMangaDetails(mangaId);
  validateManga(manga, series.title);
  const chapters = await client.getChapters(manga, { showLocked: true });
  validateChapterList(manga, chapters);
  return { chapters, client, manga };
};

export const assertNovelDashCatalogContract = async (site: NovelDashSite): Promise<void> => {
  const client = new NovelDashClient(site);
  const [account, catalog, genres] = await Promise.all([
    fetchNovelDashAccountStatus(site),
    client.getCatalogPage({ title: "" }, { id: "updated", label: "Recently updated" }, 1),
    client.getGenres(),
  ]);

  assert.deepEqual(account, { authenticated: false });
  assert.ok(catalog.items.length > 0);
  assert.ok(catalog.total >= catalog.items.length);
  assert.ok(catalog.totalPages >= 1);
  assert.ok(genres.length >= 10);
  for (const item of catalog.items) {
    assert.ok(item.mangaId.length > 0);
    assert.ok(item.title.length > 0);
    assert.match(item.imageUrl, /^https:\/\//);
  }
};

export const assertNovelDashCompleteHistory = async (
  site: NovelDashSite,
  series: NovelDashLiveSeries,
): Promise<void> => {
  const { chapters, client, manga } = await loadSeries(site, series);
  const declaredCount = Number(manga.mangaInfo.additionalInfo?.chapterCount);
  const minimumChapters = series.minimumChapters ?? 101;
  assert.ok(chapters.length >= minimumChapters);
  assert.ok(chapters.some((chapter) => chapter.chapNum > 100));
  assert.ok(Number.isSafeInteger(declaredCount) && declaredCount >= minimumChapters);
  assert.ok(
    chapters.length >= declaredCount,
    `Loaded ${chapters.length} of ${declaredCount} declared chapters.`,
  );

  if (series.internalSlug) {
    assert.equal(manga.mangaInfo.additionalInfo?.routeSlug, series.slug);
    assert.equal(manga.mangaInfo.additionalInfo?.internalSlug, series.internalSlug);
    assert.notEqual(series.internalSlug, series.slug);
  }

  const readable = chapters.find(
    (chapter) =>
      chapter.additionalInfo?.isAccessible === "true" &&
      chapter.chapNum > (series.readableAfterChapter ?? 100),
  );
  assert.ok(readable, `${series.title} did not expose a readable chapter beyond page one.`);
  await validateReader(site, series.kind, readable, await client.getChapterDetails(readable));

  const locked = chapters.find((chapter) => chapter.additionalInfo?.isAccessible === "false");
  assert.ok(locked, `${series.title} did not expose a live locked-state fixture.`);
  await assert.rejects(() => client.getChapterDetails(locked), /locked.*sign in/i);
};

export const assertNovelDashReaderContract = async (
  site: NovelDashSite,
  series: NovelDashLiveSeries,
): Promise<void> => {
  const { chapters, client } = await loadSeries(site, series);
  const readable = chapters
    .filter((chapter) => chapter.additionalInfo?.isAccessible === "true")
    .at(-1);
  assert.ok(readable, `${series.title} did not expose a readable chapter.`);
  await validateReader(site, series.kind, readable, await client.getChapterDetails(readable));
};
