import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";

import { ContentRating, DiscoverSectionType, type Request, type Response } from "@paperback/types";

type QueuedResponse = { body: unknown; status?: number };

const originalApplication = globalThis.Application;
const requests: Request[] = [];
const responses: QueuedResponse[] = [];
const state = new Map<string, unknown>();
const secureState = new Map<string, unknown>();

const encode = (value: string): ArrayBuffer => new TextEncoder().encode(value).buffer;

Object.assign(globalThis, {
  Application: {
    Selector: <T>(target: T, method: keyof T) => ({ target, method }),
    arrayBufferToUTF8String: (buffer: ArrayBuffer) => new TextDecoder().decode(buffer),
    getDefaultUserAgent: async () => "Paperback Test/0.9",
    getSecureState: (key: string) => secureState.get(key),
    setSecureState: (value: unknown, key: string) => secureState.set(key, value),
    getState: (key: string) => state.get(key),
    setState: (value: unknown, key: string) => state.set(key, value),
    scheduleRequest: async (request: Request): Promise<[Response, ArrayBuffer]> => {
      requests.push(request);
      const next = responses.shift();
      assert.ok(next, `Unexpected request: ${request.url}`);
      return [
        {
          url: request.url,
          status: next.status ?? 200,
          headers: {},
          cookies: [],
        } as Response,
        encode(JSON.stringify(next.body)),
      ];
    },
  },
});

const { VortexScansExtension } = await import("./main.js");
const { VORTEX_COOKIE_STATE_KEY } = await import("./cookies.js");

beforeEach(() => {
  requests.length = 0;
  responses.length = 0;
  state.clear();
  secureState.clear();
});

after(() => {
  Object.assign(globalThis, { Application: originalApplication });
});

const post = {
  id: 42,
  slug: "the-dungeon-painter",
  postTitle: "The Dungeon Painter",
  postContent: "A painted dungeon.",
  featuredImage: "https://storage.vortexscans.org/cover.webp",
  seriesStatus: "ONGOING",
  seriesType: "MANHWA",
  genres: [{ id: 7, name: "Mature" }],
};

describe("VortexScansExtension", () => {
  it("persists and removes first-party cookies returned by Cloudflare bypass", async () => {
    const extension = new VortexScansExtension();
    const activeCookie = {
      name: "cf_clearance",
      value: "clearance",
      domain: ".vortexscans.org",
      path: "/",
      expires: new Date(Date.now() + 60_000),
    };

    await extension.cloudflareBypassCompleted(
      { url: "https://vortexscans.org/", method: "GET" },
      [activeCookie],
      {},
    );
    assert.deepEqual(secureState.get(VORTEX_COOKIE_STATE_KEY), [activeCookie]);

    await extension.cloudflareBypassCompleted(
      { url: "https://vortexscans.org/", method: "GET" },
      [{ ...activeCookie, expires: new Date(Date.now() - 1) }],
      {},
    );
    assert.deepEqual(secureState.get(VORTEX_COOKIE_STATE_KEY), []);
  });

  it("returns no items for an unknown discovery section", async () => {
    const extension = new VortexScansExtension();

    const result = await extension.getDiscoverSectionItems(
      { id: "unknown", title: "Unknown", type: DiscoverSectionType.simpleCarousel },
      undefined,
    );

    assert.deepEqual(result, { items: [] });
    assert.equal(requests.length, 0);
  });

  it("maps paginated search responses into Paperback results", async () => {
    responses.push({ body: { posts: [post], totalCount: 19 } });
    const extension = new VortexScansExtension();

    const result = await extension.getSearchResults({ title: " dungeon " }, undefined, {
      id: "totalViews",
      label: "Most viewed",
    });

    assert.equal(result.items[0]?.mangaId, "the-dungeon-painter@42");
    assert.equal(result.items[0]?.title, "The Dungeon Painter");
    assert.equal(result.items[0]?.contentRating, ContentRating.MATURE);
    assert.deepEqual(result.metadata, { page: 2 });
    assert.match(requests[0]?.url ?? "", /searchTerm=dungeon/);
    assert.match(requests[0]?.url ?? "", /orderBy=totalViews/);
  });

  it("loads manga details and the complete paid-aware chapter list", async () => {
    responses.push(
      { body: { post } },
      {
        body: {
          post: {
            chapters: [
              {
                id: 31750,
                slug: "chapter-18",
                number: 18,
                price: 0,
                isAccessible: true,
              },
              {
                id: 31751,
                slug: "chapter-19",
                number: 19,
                title: "Preview",
                price: 100,
                isLocked: true,
                isPermanentlyLocked: true,
                chapterPurchased: false,
                isAccessible: false,
              },
            ],
          },
        },
      },
    );
    const extension = new VortexScansExtension();

    const manga = await extension.getMangaDetails("the-dungeon-painter@42");
    const chapters = await extension.getChapters(manga);

    assert.equal(chapters.length, 2);
    assert.equal(chapters[1]?.additionalInfo?.isAccessible, "false");
    assert.equal(chapters[1]?.additionalInfo?.price, "100");
    assert.match(requests[1]?.url ?? "", /\/chapters\?postId=42&take=all$/);
  });

  it("reads purchased content through the authenticated protected-reader endpoint", async () => {
    responses.push({
      body: {
        isAccessible: true,
        isPurchased: true,
        images: [
          { order: 1, url: "https://storage.vortexscans.org/page-2.webp" },
          { order: 0, url: "https://storage.vortexscans.org/page-1.webp" },
        ],
      },
    });
    const extension = new VortexScansExtension();
    const sourceManga = {
      mangaId: "the-dungeon-painter@42",
      mangaInfo: {
        primaryTitle: "The Dungeon Painter",
        secondaryTitles: [],
        thumbnailUrl: "https://storage.vortexscans.org/cover.webp",
        synopsis: "",
        contentRating: ContentRating.MATURE,
        additionalInfo: { slug: "the-dungeon-painter", id: "42" },
      },
    };

    const details = await extension.getChapterDetails({
      chapterId: "31751",
      sourceManga,
      langCode: "en",
      chapNum: 19,
      additionalInfo: { slug: "chapter-19", isAccessible: "true" },
    });

    assert.ok("pages" in details);
    if ("pages" in details) {
      assert.deepEqual(details.pages, [
        "https://storage.vortexscans.org/page-1.webp",
        "https://storage.vortexscans.org/page-2.webp",
      ]);
    }
    assert.match(requests[0]?.url ?? "", /\/chapter\/content\?/);
  });

  it("surfaces HTTP-200 access denials instead of returning an empty reader", async () => {
    responses.push({
      body: { isAccessible: false, isPurchased: false, content: null, images: [] },
    });
    const extension = new VortexScansExtension();
    const sourceManga = {
      mangaId: "the-dungeon-painter@42",
      mangaInfo: {
        primaryTitle: "The Dungeon Painter",
        secondaryTitles: [],
        thumbnailUrl: "",
        synopsis: "",
        contentRating: ContentRating.MATURE,
        additionalInfo: { slug: "the-dungeon-painter", id: "42" },
      },
    };

    await assert.rejects(
      extension.getChapterDetails({
        chapterId: "31751",
        sourceManga,
        langCode: "en",
        chapNum: 19,
        additionalInfo: { slug: "chapter-19", price: "100", isAccessible: "false" },
      }),
      /locked|accessible|unlock/i,
    );
  });
});
