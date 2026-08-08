import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { ContentRating, type Chapter, type Request, type Response } from "@paperback/types";

import {
  fetchChapterContent,
  fetchChapterList,
  fetchGenres,
  fetchPostDetails,
  resolveUrlQuery,
} from "./client.js";

type ScheduledResult = { body: unknown; status?: number };

const originalApplication = globalThis.Application;

const encode = (value: string): ArrayBuffer => new TextEncoder().encode(value).buffer;

const installApplication = (results: ScheduledResult[]): Request[] => {
  const requests: Request[] = [];
  Object.assign(globalThis, {
    Application: {
      arrayBufferToUTF8String: (buffer: ArrayBuffer) => new TextDecoder().decode(buffer),
      scheduleRequest: async (request: Request): Promise<[Response, ArrayBuffer]> => {
        requests.push(request);
        const next = results.shift();
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
  return requests;
};

const sourceManga = {
  mangaId: "the-dungeon-painter@42",
  mangaInfo: {
    primaryTitle: "The Dungeon Painter",
    secondaryTitles: [],
    thumbnailUrl: "https://storage.vortexscans.org/cover.webp",
    synopsis: "",
    contentRating: ContentRating.MATURE,
    tagGroups: [],
    additionalInfo: { slug: "the-dungeon-painter", id: "42" },
  },
};

afterEach(() => {
  Object.assign(globalThis, { Application: originalApplication });
});

describe("Vortex API client", () => {
  it("normalizes and sorts the public genre list", async () => {
    const requests = installApplication([
      {
        body: [
          { id: 3, name: " Romance " },
          { id: 1, name: "Action" },
          { id: 9, name: "" },
        ],
      },
    ]);

    assert.deepEqual(await fetchGenres(), [
      { id: "1", title: "Action" },
      { id: "3", title: "Romance" },
    ]);
    assert.equal(requests[0]?.url, "https://api.vortexscans.org/api/genres");
  });

  it("fetches manga details by the decoded composite slug", async () => {
    const requests = installApplication([{ body: { post: { id: 42 } } }]);

    await fetchPostDetails("the-dungeon-painter@42");

    assert.equal(
      requests[0]?.url,
      "https://api.vortexscans.org/api/post?postSlug=the-dungeon-painter",
    );
  });

  it("loads the complete chapter list using the numeric post id", async () => {
    const requests = installApplication([{ body: { post: { chapters: [] } } }]);

    await fetchChapterList(sourceManga);

    assert.equal(requests[0]?.url, "https://api.vortexscans.org/api/chapters?postId=42&take=all");
  });

  it("resolves a legacy slug-only manga id before requesting chapters", async () => {
    const legacy = {
      ...sourceManga,
      mangaId: "the-dungeon-painter",
      mangaInfo: { ...sourceManga.mangaInfo, additionalInfo: {} },
    };
    const requests = installApplication([
      { body: { post: { id: 42, slug: "the-dungeon-painter" } } },
      { body: { post: { chapters: [] } } },
    ]);

    await fetchChapterList(legacy);

    assert.match(requests[0]?.url ?? "", /\/post\?postSlug=the-dungeon-painter$/);
    assert.match(requests[1]?.url ?? "", /\/chapters\?postId=42&take=all$/);
  });

  it("uses the protected slug reader so stored session cookies can unlock purchases", async () => {
    const chapter: Chapter = {
      chapterId: "31751",
      sourceManga,
      langCode: "en",
      chapNum: 19,
      additionalInfo: { slug: "chapter-19" },
    };
    const requests = installApplication([
      { body: { isAccessible: true, isPurchased: true, images: [] } },
    ]);

    await fetchChapterContent(chapter);

    assert.equal(
      requests[0]?.url,
      "https://api.vortexscans.org/api/chapter/content?mangaslug=the-dungeon-painter&chapterslug=chapter-19",
    );
    assert.equal(requests[0]?.headers?.["cache-control"], "no-store");
  });

  it("falls back to the numeric chapter endpoint for legacy chapter records", async () => {
    const chapter: Chapter = {
      chapterId: "31751",
      sourceManga,
      langCode: "en",
      chapNum: 19,
    };
    const requests = installApplication([{ body: { chapter: { id: 31751 } } }]);

    await fetchChapterContent(chapter);

    assert.equal(requests[0]?.url, "https://api.vortexscans.org/api/chapter?chapterId=31751");
  });

  it("turns a pasted Vortex series URL into one search result", async () => {
    installApplication([
      {
        body: {
          post: {
            id: 42,
            slug: "the-dungeon-painter",
            postTitle: "The Dungeon Painter",
            featuredImage: "/cover.webp",
            genres: [{ id: 7, name: "Mature" }],
          },
        },
      },
    ]);

    const result = await resolveUrlQuery(
      "https://vortexscans.org/series/the-dungeon-painter?from=paperback",
    );

    assert.equal(result?.items.length, 1);
    assert.equal(result?.items[0]?.mangaId, "the-dungeon-painter@42");
    assert.equal(result?.items[0]?.contentRating, ContentRating.MATURE);
    assert.equal(await resolveUrlQuery("not a Vortex URL"), undefined);
  });
});
