import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  ContentRating,
  DiscoverSectionType,
  type Chapter,
  type ChapterDetails,
  type Cookie,
  type DiscoverSection,
  type PagedResults,
  type SearchQuery,
  type SearchResultItem,
  type SortingOption,
  type SourceManga,
  type Tag,
  type UpdateManager,
} from "@paperback/types";

import {
  SECTIONS,
  SORTING_OPTIONS,
  ThunderScansExtension,
  type ThunderClientContract,
} from "./main.js";
import type {
  HomeFeedId,
  ParsedHomeFeed,
  ParsedListPage,
  ThunderListItem,
  ThunderSearchMetadata,
} from "./models.js";

const originalApplication = globalThis.Application;

const listItem = (overrides: Partial<ThunderListItem> = {}): ThunderListItem => ({
  mangaId: "storm-architect",
  title: "Storm Architect",
  imageUrl: "https://en-thunderscans.com/cover.jpg",
  contentRating: ContentRating.MATURE,
  subtitle: "Chapter 3 • Ongoing",
  latestChapterId: "3",
  status: "Ongoing",
  rating: 0.94,
  ...overrides,
});

const sourceManga = (): SourceManga => ({
  mangaId: "storm-architect",
  mangaInfo: {
    primaryTitle: "Storm Architect",
    secondaryTitles: [],
    thumbnailUrl: "https://en-thunderscans.com/cover.jpg",
    synopsis: "Synthetic synopsis",
    contentRating: ContentRating.MATURE,
  },
});

class FakeClient implements ThunderClientContract {
  homeCalls: [HomeFeedId, number | undefined][] = [];
  directoryCalls: [SearchQuery<ThunderSearchMetadata>, SortingOption | undefined, number][] = [];
  autocompleteCalls: [string, ThunderSearchMetadata | undefined][] = [];
  invalidations = 0;

  async getDirectoryPage(
    query: SearchQuery<ThunderSearchMetadata>,
    sorting: SortingOption | undefined,
    page: number,
  ): Promise<ParsedListPage> {
    this.directoryCalls.push([query, sorting, page]);
    return { items: [listItem()], hasNextPage: page < 2 };
  }

  async getHomeFeed(feed: HomeFeedId, page?: number): Promise<ParsedHomeFeed> {
    this.homeCalls.push([feed, page]);
    const contentType = feed === "latestNovels" ? ("novel" as const) : undefined;
    return {
      items: [listItem({ mangaId: `${feed}-title`, contentType })],
      ...((feed === "latestComics" || feed === "latestNovels") && { nextPage: (page ?? 1) + 1 }),
    };
  }

  async getGenres(): Promise<Tag[]> {
    return [
      { id: "10", title: "Action" },
      { id: "20", title: "Adult" },
    ];
  }

  async getAutocompleteResults(
    title: string,
    metadata?: ThunderSearchMetadata,
  ): Promise<ThunderListItem[]> {
    this.autocompleteCalls.push([title, metadata]);
    return [listItem({ mangaId: "filtered-title" })];
  }

  async getMangaDetails(_mangaId: string): Promise<SourceManga> {
    return sourceManga();
  }

  async getChapters(manga: SourceManga, showLocked: boolean): Promise<Chapter[]> {
    return [
      {
        chapterId: showLocked ? "locked-visible" : "available-only",
        sourceManga: manga,
        langCode: "en",
        chapNum: 1,
      },
    ];
  }

  async getChapterDetails(chapter: Chapter): Promise<ChapterDetails> {
    return {
      id: chapter.chapterId,
      mangaId: chapter.sourceManga.mangaId,
      pages: ["https://cdn/page.jpg"],
    };
  }

  async resolvePastedUrl(query: string): Promise<PagedResults<SearchResultItem> | undefined> {
    return query.startsWith("https://")
      ? {
          items: [
            {
              mangaId: "pasted",
              title: "Pasted",
              imageUrl: "https://en-thunderscans.com/pasted.jpg",
              contentRating: ContentRating.EVERYONE,
            },
          ],
        }
      : undefined;
  }

  invalidateAuthenticationCaches(): void {
    this.invalidations += 1;
  }
}

let state = new Map<string, unknown>();
let secureState = new Map<string, unknown>();

beforeEach(() => {
  state = new Map();
  secureState = new Map();
  Object.assign(globalThis, {
    Application: {
      Selector: () => "selector",
      formDidChange: () => undefined,
      getState: (key: string) => state.get(key),
      setState: (value: unknown, key: string) => state.set(key, value),
      getSecureState: (key: string) => secureState.get(key),
      setSecureState: (value: unknown, key: string) => secureState.set(key, value),
      getDefaultUserAgent: async () => "Paperback Test/0.9",
      arrayBufferToUTF8String: (buffer: ArrayBuffer) => new TextDecoder().decode(buffer),
    },
  });
});

afterEach(() => {
  Object.assign(globalThis, { Application: originalApplication });
});

describe("ThunderScansExtension", () => {
  it("advertises every useful live-site discovery feed", async () => {
    const extension = new ThunderScansExtension(new FakeClient());
    const sections = await extension.getDiscoverSections();

    assert.deepEqual(
      sections.map((section) => section.id),
      [
        SECTIONS.POPULAR,
        SECTIONS.EDITORS,
        SECTIONS.LATEST_COMICS,
        SECTIONS.LATEST_NOVELS,
        SECTIONS.RECENTLY_ADDED,
        SECTIONS.GENRES,
      ],
    );
  });

  it("maps featured, update, directory, and genre sections with pagination", async () => {
    const client = new FakeClient();
    const extension = new ThunderScansExtension(client);
    const sections = await extension.getDiscoverSections();
    const byId = (id: string): DiscoverSection => sections.find((section) => section.id === id)!;

    const popular = await extension.getDiscoverSectionItems(byId(SECTIONS.POPULAR), undefined);
    const latest = await extension.getDiscoverSectionItems(byId(SECTIONS.LATEST_COMICS), undefined);
    const recent = await extension.getDiscoverSectionItems(byId(SECTIONS.RECENTLY_ADDED), {
      page: 1,
    });
    const genres = await extension.getDiscoverSectionItems(byId(SECTIONS.GENRES), undefined);

    assert.equal(popular.items[0]?.type, "featuredCarouselItem");
    assert.equal(latest.items[0]?.type, "chapterUpdatesCarouselItem");
    assert.deepEqual(latest.metadata, { page: 2 });
    assert.equal(recent.items[0]?.type, "prominentCarouselItem");
    assert.deepEqual(recent.metadata, { page: 2 });
    assert.equal(genres.items[1]?.type, "genresCarouselItem");
    assert.equal(genres.items[1]?.contentRating, ContentRating.ADULT);
    assert.equal(client.directoryCalls[0]?.[1]?.id, "latest");
  });

  it("returns no data or requests for an unknown discovery section", async () => {
    const client = new FakeClient();
    const extension = new ThunderScansExtension(client);
    const result = await extension.getDiscoverSectionItems(
      { id: "unknown", title: "Unknown", type: DiscoverSectionType.simpleCarousel },
      undefined,
    );

    assert.deepEqual(result, { items: [] });
    assert.equal(client.homeCalls.length + client.directoryCalls.length, 0);
  });

  it("uses structured search only when WordPress would ignore advanced filters", async () => {
    const client = new FakeClient();
    const extension = new ThunderScansExtension(client);
    const filteredQuery: SearchQuery<ThunderSearchMetadata> = {
      title: "storm",
      metadata: { type: ["novel"] },
    };

    const filtered = await extension.getSearchResults(filteredQuery, undefined);
    const plain = await extension.getSearchResults({ title: "storm" }, { page: 2 });
    const pasted = await extension.getSearchResults(
      { title: "https://en-thunderscans.com/comics/storm/" },
      undefined,
    );

    assert.equal(filtered.items[0]?.mangaId, "filtered-title");
    assert.equal(plain.items[0]?.mangaId, "storm-architect");
    assert.equal(client.autocompleteCalls.length, 1);
    assert.equal(client.directoryCalls.at(-1)?.[2], 2);
    assert.equal(pasted.items[0]?.mangaId, "pasted");
    assert.deepEqual(await extension.getSortingOptions(filteredQuery), []);
    assert.deepEqual(await extension.getSortingOptions({ title: "" }), SORTING_OPTIONS);
  });

  it("delegates details and respects the locked-chapter preference", async () => {
    const client = new FakeClient();
    const extension = new ThunderScansExtension(client);
    const manga = await extension.getMangaDetails("storm-architect");

    const visible = await extension.getChapters(manga);
    state.set("thunder_scans.show_locked_chapters", false);
    const hidden = await extension.getChapters(manga);
    const details = await extension.getChapterDetails(hidden[0]!);

    assert.equal(visible[0]?.chapterId, "locked-visible");
    assert.equal(hidden[0]?.chapterId, "available-only");
    assert.equal(details.id, "available-only");
  });

  it("prioritizes titles present in either latest feed without skipping the rest", async () => {
    const client = new FakeClient();
    const extension = new ThunderScansExtension(client);
    const priorities = new Map<string, "high" | "low" | "skip">();
    const queued = [
      sourceManga(),
      { ...sourceManga(), mangaId: "latestComics-title" },
      { ...sourceManga(), mangaId: "latestNovels-title" },
    ];
    const manager = {
      getQueuedItems: () => queued,
      setUpdatePriority: async (mangaId: string, priority: "high" | "low" | "skip") => {
        priorities.set(mangaId, priority);
      },
    } as UpdateManager;

    await extension.processTitlesForUpdates(manager);

    assert.deepEqual(
      priorities,
      new Map([
        ["storm-architect", "low"],
        ["latestComics-title", "high"],
        ["latestNovels-title", "high"],
      ]),
    );
    assert.deepEqual(client.homeCalls, [
      ["latestComics", undefined],
      ["latestNovels", undefined],
    ]);
  });

  it("stores first-party bypass cookies and invalidates authenticated HTML caches", async () => {
    const client = new FakeClient();
    const extension = new ThunderScansExtension(client);
    const cookies: Cookie[] = [
      { name: "PHPSESSID", value: "new", domain: "en-thunderscans.com", path: "/" },
      { name: "foreign", value: "no", domain: "example.com", path: "/" },
    ];

    await extension.cloudflareBypassCompleted(
      { url: "https://en-thunderscans.com/", method: "GET" },
      cookies,
      {},
    );

    assert.equal(client.invalidations, 1);
    const stored = secureState.get("thunder_scans.secure_cookies") as Cookie[];
    assert.deepEqual(
      stored.map((cookie) => cookie.name),
      ["PHPSESSID"],
    );
  });
});
