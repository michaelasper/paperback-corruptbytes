import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  ContentRating,
  DiscoverSectionType,
  type Chapter,
  type ChapterDetails,
  type Cookie,
  type PagedResults,
  type Request,
  type Response,
  type SearchQuery,
  type SearchResultItem,
  type SortingOption,
  type SourceManga,
  type Tag,
} from "@paperback/types";

import { REFRESH_URL } from "./auth.js";
import { QiMangaExtension, SECTIONS, SORTING_OPTIONS, type QiMangaClientContract } from "./main.js";
import type { QiMangaCard, QiMangaSearchMetadata } from "./models.js";
import type { QiMangaHome, QiMangaSeriesPage } from "./parsers.js";
import { LATEST_RESPONSE } from "./test-fixtures.js";

const originalApplication = globalThis.Application;
let state = new Map<string, unknown>();

beforeEach(() => {
  state = new Map();
  Object.assign(globalThis, {
    Application: {
      Selector: (_form: unknown, method: string) => method,
      getState: (key: string) => state.get(key),
      setState: (value: unknown, key: string) => state.set(key, value),
      getSecureState: (key: string) => state.get(`secure:${key}`),
      setSecureState: (value: unknown, key: string) => state.set(`secure:${key}`, value),
    },
  });
});

afterEach(() => Object.assign(globalThis, { Application: originalApplication }));

const card = (overrides: Partial<QiMangaCard> = {}): QiMangaCard => ({
  mangaId: "series-one",
  title: "Series One",
  imageUrl: "https://media.qimanga.com/series.webp",
  contentRating: ContentRating.EVERYONE,
  rating: 0.9,
  type: "MANHWA",
  status: "ONGOING",
  ...overrides,
});

class FakeClient implements QiMangaClientContract {
  searchCalls: {
    query: SearchQuery<QiMangaSearchMetadata>;
    sortingOption?: SortingOption;
    page: number;
  }[] = [];
  latestPages: number[] = [];
  chapterOptions: { showLocked?: boolean; sinceDate?: Date }[] = [];
  pasted: PagedResults<SearchResultItem> | undefined;
  cacheInvalidations = 0;
  accountCacheInvalidations = 0;

  async getHome(): Promise<QiMangaHome> {
    return {
      banners: [card()],
      popular: [card({ mangaId: "popular", title: "Popular" })],
      pinned: [card({ mangaId: "pinned", title: "Pinned" })],
      editorsPick: [card({ mangaId: "editors", title: "Editors" })],
      newSeries: [card({ mangaId: "new", title: "New" })],
    };
  }

  async getLatest(page: number): Promise<QiMangaSeriesPage> {
    this.latestPages.push(page);
    return { items: [card({ mangaId: `latest-${page}` })], page, pageCount: 2, totalCount: 2 };
  }

  async getSearchPage(
    query: SearchQuery<QiMangaSearchMetadata>,
    sortingOption: SortingOption | undefined,
    page: number,
  ): Promise<QiMangaSeriesPage> {
    this.searchCalls.push({ query, ...(sortingOption && { sortingOption }), page });
    return { items: [card()], page, pageCount: 2, totalCount: 2 };
  }

  async getGenres(): Promise<Tag[]> {
    return [
      { id: "action", title: "Action" },
      { id: "ecchi", title: "Ecchi" },
    ];
  }

  async getMangaDetails(mangaId: string): Promise<SourceManga> {
    return {
      mangaId,
      mangaInfo: {
        primaryTitle: "Series One",
        secondaryTitles: [],
        thumbnailUrl: "https://media.qimanga.com/series.webp",
        synopsis: "",
        contentRating: ContentRating.EVERYONE,
      },
    };
  }

  async getChapters(
    _sourceManga: SourceManga,
    options: { showLocked?: boolean; sinceDate?: Date } = {},
  ): Promise<Chapter[]> {
    this.chapterOptions.push(options);
    return [];
  }

  async getChapterDetails(chapter: Chapter): Promise<ChapterDetails> {
    return { id: chapter.chapterId, mangaId: chapter.sourceManga.mangaId, pages: [] };
  }

  async resolvePastedUrl(_query: string): Promise<PagedResults<SearchResultItem> | undefined> {
    return this.pasted;
  }

  invalidateAccountCaches(): void {
    this.accountCacheInvalidations += 1;
  }

  invalidateCaches(): void {
    this.cacheInvalidations += 1;
  }
}

describe("Qi Manga extension", () => {
  it("exposes every enabled site rail with accurate section types", async () => {
    const sections = await new QiMangaExtension(new FakeClient()).getDiscoverSections();
    assert.deepEqual(
      sections.map(({ id, type }) => ({ id, type })),
      [
        { id: SECTIONS.FEATURED, type: DiscoverSectionType.featured },
        { id: SECTIONS.POPULAR, type: DiscoverSectionType.simpleCarousel },
        { id: SECTIONS.PINNED, type: DiscoverSectionType.prominentCarousel },
        { id: SECTIONS.LATEST, type: DiscoverSectionType.simpleCarousel },
        { id: SECTIONS.EDITORS_PICK, type: DiscoverSectionType.prominentCarousel },
        { id: SECTIONS.NEW_SERIES, type: DiscoverSectionType.prominentCarousel },
        { id: SECTIONS.GENRES, type: DiscoverSectionType.genres },
      ],
    );
  });

  it("maps featured and curated home cards without inventing pagination", async () => {
    const extension = new QiMangaExtension(new FakeClient());
    const featured = await extension.getDiscoverSectionItems(
      { id: SECTIONS.FEATURED, title: "Featured", type: DiscoverSectionType.featured },
      undefined,
    );
    const pinned = await extension.getDiscoverSectionItems(
      { id: SECTIONS.PINNED, title: "Pinned", type: DiscoverSectionType.prominentCarousel },
      undefined,
    );

    assert.deepEqual(featured.metadata, undefined);
    assert.equal(featured.items[0]?.type, "featuredCarouselItem");
    assert.equal((featured.items[0] as { supertitle?: string }).supertitle, "Manhwa · Ongoing");
    assert.equal(pinned.items[0]?.type, "prominentCarouselItem");

    const massReleasedClient = new (class extends FakeClient {
      override async getHome(): Promise<QiMangaHome> {
        return {
          banners: [card({ status: "MASS_RELEASED" })],
          popular: [],
          pinned: [],
          editorsPick: [],
          newSeries: [],
        };
      }
    })();
    const massReleased = await new QiMangaExtension(massReleasedClient).getDiscoverSectionItems(
      { id: SECTIONS.FEATURED, title: "Featured", type: DiscoverSectionType.featured },
      undefined,
    );
    assert.equal(
      (massReleased.items[0] as { supertitle?: string }).supertitle,
      "Manhwa · Mass Released",
    );
  });

  it("paginates latest updates exactly to the server boundary", async () => {
    const client = new FakeClient();
    const extension = new QiMangaExtension(client);
    const first = await extension.getDiscoverSectionItems(
      { id: SECTIONS.LATEST, title: "Latest", type: DiscoverSectionType.simpleCarousel },
      undefined,
    );
    const last = await extension.getDiscoverSectionItems(
      { id: SECTIONS.LATEST, title: "Latest", type: DiscoverSectionType.simpleCarousel },
      { page: 2 },
    );

    assert.deepEqual(first.metadata, { page: 2 });
    assert.equal(last.metadata, undefined);
    assert.deepEqual(client.latestPages, [1, 2]);
  });

  it("turns genre taxonomy into working searches and preserves mature labels", async () => {
    const result = await new QiMangaExtension(new FakeClient()).getDiscoverSectionItems(
      { id: SECTIONS.GENRES, title: "Genres", type: DiscoverSectionType.genres },
      undefined,
    );
    assert.deepEqual(result.items, [
      {
        type: "genresCarouselItem",
        name: "Action",
        searchQuery: { title: "", metadata: { genre: "action" } },
        contentRating: ContentRating.EVERYONE,
      },
      {
        type: "genresCarouselItem",
        name: "Ecchi",
        searchQuery: { title: "", metadata: { genre: "ecchi" } },
        contentRating: ContentRating.MATURE,
      },
    ]);
  });

  it("returns mutation-isolated browse sorting and hides it for title search", async () => {
    const extension = new QiMangaExtension(new FakeClient());
    const first = await extension.getSortingOptions({ title: "" });
    first[0]!.label = "Changed";
    first.pop();
    assert.deepEqual(await extension.getSortingOptions({ title: "" }), SORTING_OPTIONS);
    assert.deepEqual(await extension.getSortingOptions({ title: "demon" }), []);
  });

  it("delegates complete searches, sorting, and page state", async () => {
    const client = new FakeClient();
    const extension = new QiMangaExtension(client);
    const query: SearchQuery<QiMangaSearchMetadata> = {
      title: "demon",
      metadata: { genre: "action", type: "MANHWA" },
    };
    const result = await extension.getSearchResults(query, { page: 1 }, SORTING_OPTIONS[2]);

    assert.equal(result.items[0]?.mangaId, "series-one");
    assert.deepEqual(result.metadata, { page: 2 });
    assert.deepEqual(client.searchCalls[0], {
      query,
      sortingOption: { id: "popular", label: "Popular" },
      page: 1,
    });
  });

  it("returns a pasted URL result before running catalog search", async () => {
    const client = new FakeClient();
    client.pasted = {
      items: [
        {
          mangaId: "direct",
          title: "Direct",
          imageUrl: "https://media.qimanga.com/direct.webp",
        },
      ],
    };
    const result = await new QiMangaExtension(client).getSearchResults(
      { title: "https://qimanga.com/series/direct" },
      undefined,
    );
    assert.equal(result.items[0]?.mangaId, "direct");
    assert.equal(client.searchCalls.length, 0);
  });

  it("passes paid-row visibility and incremental dates to the client", async () => {
    const client = new FakeClient();
    const extension = new QiMangaExtension(client);
    const manga = await client.getMangaDetails("series-one");
    const sinceDate = new Date("2026-01-01T00:00:00.000Z");
    state.set("qi_manga.show_locked_chapters", false);

    await extension.getChapters(manga, sinceDate);

    assert.deepEqual(client.chapterOptions, [{ showLocked: false, sinceDate }]);
  });

  it("refreshes an expired session through the default client transport", async () => {
    state.set("secure:qi_manga.secure_cookies", [
      { name: "refreshToken", value: "secret", domain: ".qimanga.com", path: "/" },
    ]);
    const requests: Request[] = [];
    let catalogCalls = 0;
    Object.assign(Application, {
      arrayBufferToUTF8String: (buffer: ArrayBuffer) => new TextDecoder().decode(buffer),
      scheduleRequest: async (request: Request): Promise<[Response, ArrayBuffer]> => {
        requests.push(request);
        if (request.url === REFRESH_URL) {
          return [{ url: request.url, status: 204, headers: {}, cookies: [] }, new ArrayBuffer(0)];
        }
        catalogCalls += 1;
        const status = catalogCalls === 1 ? 401 : 200;
        return [
          { url: request.url, status, headers: {}, cookies: [] },
          new TextEncoder().encode(status === 200 ? JSON.stringify(LATEST_RESPONSE) : "").buffer,
        ];
      },
    });

    const results = await new QiMangaExtension().getSearchResults({ title: "" }, undefined);

    assert.equal(results.items.length, 2);
    assert.deepEqual(
      requests.map((request) => [request.method, request.url]),
      [
        ["GET", "https://api.qimanga.com/api/v1/series?page=1&perPage=100&sort=latest"],
        ["POST", REFRESH_URL],
        ["GET", "https://api.qimanga.com/api/v1/series?page=1&perPage=100&sort=latest"],
      ],
    );
  });

  it("revalidates account-sensitive chapter state when settings open", async () => {
    const client = new FakeClient();

    await new QiMangaExtension(client).getSettingsForm();

    assert.equal(client.accountCacheInvalidations, 1);
  });

  it("bounds malformed Cloudflare callback cookie arrays before inspection", async () => {
    const client = new FakeClient();
    const extension = new QiMangaExtension(client);
    const cookies = [
      ...(Array.from({ length: 1_024 }, (_, index) => ({
        name: `account_${index}`,
        value: "ignored",
        domain: ".qimanga.com",
        path: "/",
      })) as Cookie[]),
      { name: "cf_clearance", value: "too-late", domain: ".qimanga.com", path: "/" },
    ];

    await extension.cloudflareBypassCompleted(
      { url: "https://qimanga.com/", method: "GET" },
      cookies,
      {},
    );

    const stored = state.get("secure:qi_manga.secure_cookies") as Cookie[];
    assert.deepEqual(stored, []);
    assert.equal(client.cacheInvalidations, 1);

    const throwingArray = new Proxy(
      [{ name: "cf_clearance", value: "hidden", domain: ".qimanga.com", path: "/" }],
      {
        get: (target, property, receiver) => {
          if (property === "0") throw new Error("malformed callback member");
          return Reflect.get(target, property, receiver);
        },
      },
    );
    await assert.doesNotReject(
      extension.cloudflareBypassCompleted(
        { url: "https://qimanga.com/", method: "GET" },
        throwingArray,
        {},
      ),
    );
    assert.deepEqual(state.get("secure:qi_manga.secure_cookies"), []);

    let nameReads = 0;
    const changingCookie = new Proxy(
      { name: "cf_clearance", value: "safe", domain: ".qimanga.com", path: "/" },
      {
        get: (target, property, receiver) => {
          if (property === "name") {
            nameReads += 1;
            return nameReads === 1 ? "cf_clearance" : "accessToken";
          }
          return Reflect.get(target, property, receiver);
        },
      },
    );
    await extension.cloudflareBypassCompleted(
      { url: "https://qimanga.com/", method: "GET" },
      [changingCookie],
      {},
    );
    assert.equal(nameReads, 1);
    assert.deepEqual(
      (state.get("secure:qi_manga.secure_cookies") as Cookie[]).map(({ name }) => name),
      ["cf_clearance"],
    );
  });

  it("persists only accepted bypass cookies and invalidates account-sensitive caches", async () => {
    const client = new FakeClient();
    const extension = new QiMangaExtension(client);
    const cookies: Cookie[] = [
      { name: "cf_clearance", value: "ok", domain: ".qimanga.com", path: "/" },
      { name: "accessToken", value: "unverified", domain: ".qimanga.com", path: "/" },
      { name: "foreign", value: "no", domain: "example.com", path: "/" },
    ];

    await extension.cloudflareBypassCompleted(
      { url: "https://qimanga.com/", method: "GET" },
      cookies,
      {},
    );

    assert.equal(client.cacheInvalidations, 1);
    const stored = state.get("secure:qi_manga.secure_cookies") as Cookie[];
    assert.deepEqual(
      stored.map((cookie) => cookie.name),
      ["cf_clearance"],
    );
  });
});
