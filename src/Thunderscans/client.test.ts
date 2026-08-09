import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  ContentRating,
  type Chapter,
  type Request,
  type Response,
  type SourceManga,
} from "@paperback/types";

import { ThunderClient } from "./client.js";
import {
  AJAX_CARDS_HTML,
  AUTOCOMPLETE_RESPONSE,
  COMIC_READER_HTML,
  DIRECTORY_HTML,
  HOME_HTML,
  SERIES_HTML,
} from "./test-fixtures.js";

const originalApplication = globalThis.Application;

interface StubResponse {
  status?: number;
  body: string;
  url?: string;
}

const installApplication = (responder: (request: Request) => StubResponse): Request[] => {
  const requests: Request[] = [];
  Object.assign(globalThis, {
    Application: {
      arrayBufferToUTF8String: (buffer: ArrayBuffer) => new TextDecoder().decode(buffer),
      scheduleRequest: async (request: Request): Promise<[Response, ArrayBuffer]> => {
        requests.push(request);
        const result = responder(request);
        return [
          {
            url: result.url ?? request.url,
            status: result.status ?? 200,
            headers: {},
            cookies: [],
          },
          new TextEncoder().encode(result.body).buffer,
        ];
      },
    },
  });
  return requests;
};

afterEach(() => {
  Object.assign(globalThis, { Application: originalApplication });
});

const sourceManga = (): SourceManga => ({
  mangaId: "storm-architect",
  mangaInfo: {
    primaryTitle: "Storm Architect",
    secondaryTitles: [],
    thumbnailUrl: "https://en-thunderscans.com/covers/storm.jpg",
    synopsis: "",
    contentRating: ContentRating.MATURE,
    additionalInfo: { slug: "storm-architect", postId: "4242" },
  },
});

describe("ThunderClient", () => {
  it("evicts a cached series document when parsing fails", async () => {
    let seriesBody = "<html><body><main>temporary shape</main></body></html>";
    const requests = installApplication(() => ({ body: seriesBody }));
    const client = new ThunderClient();

    await assert.rejects(client.getMangaDetails("storm-architect"), /valid series URL/);

    seriesBody = SERIES_HTML;
    assert.equal((await client.getMangaDetails("storm-architect")).mangaId, "storm-architect");
    assert.equal(requests.length, 2);
  });

  it("loads paginated directory results and resolves pasted series URLs", async () => {
    const requests = installApplication((request) => {
      if (request.url.includes("/comics/?page=2")) return { body: DIRECTORY_HTML };
      if (request.url.endsWith("/comics/storm-architect/")) return { body: SERIES_HTML };
      throw new Error(`Unexpected request: ${request.url}`);
    });
    const client = new ThunderClient();

    const page = await client.getDirectoryPage({ title: "" }, undefined, 2);
    const pasted = await client.resolvePastedUrl(
      "https://en-thunderscans.com/comics/storm-architect/",
    );

    assert.equal(page.items.length, 2);
    assert.equal(page.hasNextPage, true);
    assert.equal(pasted?.items[0]?.mangaId, "storm-architect");
    assert.equal(requests.length, 2);
  });

  it("coalesces and briefly caches identical series requests", async () => {
    const requests = installApplication(() => ({ body: SERIES_HTML }));
    const client = new ThunderClient();

    const [first, second] = await Promise.all([
      client.getMangaDetails("storm-architect"),
      client.getMangaDetails("storm-architect"),
    ]);
    const third = await client.getMangaDetails("storm-architect");

    assert.equal(first.mangaInfo.primaryTitle, "Storm Architect");
    assert.deepEqual(second, first);
    assert.deepEqual(third, first);
    assert.equal(requests.length, 1);
  });

  it("reuses exact chapter URLs discovered with the chapter list", async () => {
    const requests = installApplication((request) =>
      request.url.includes("chapter-2-5") ? { body: COMIC_READER_HTML } : { body: SERIES_HTML },
    );
    const client = new ThunderClient();
    const manga = sourceManga();

    const chapters = await client.getChapters(manga, true);
    const details = await client.getChapterDetails(chapters[1]!);

    assert.equal(details.id, "2.5");
    assert.equal(requests.length, 2);
    assert.equal(requests[1]?.url, "https://en-thunderscans.com/storm-architect-chapter-2-5/");
  });

  it("resolves a legacy chapter record through one series refresh before reading", async () => {
    const requests = installApplication((request) =>
      request.url.includes("chapter-1/") ? { body: COMIC_READER_HTML } : { body: SERIES_HTML },
    );
    const client = new ThunderClient();
    const legacy: Chapter = {
      chapterId: "1",
      sourceManga: sourceManga(),
      langCode: "en",
      chapNum: 1,
    };

    await client.getChapterDetails(legacy);

    assert.deepEqual(
      requests.map((request) => request.url),
      [
        "https://en-thunderscans.com/comics/storm-architect/",
        "https://en-thunderscans.com/storm-architect-chapter-1/",
      ],
    );
  });

  it("refreshes a locked record but never attempts a purchase or invented reader URL", async () => {
    const requests = installApplication(() => ({ body: SERIES_HTML }));
    const client = new ThunderClient();
    const locked: Chapter = {
      chapterId: "3",
      sourceManga: sourceManga(),
      langCode: "en",
      chapNum: 3,
      additionalInfo: { locked: "true", postId: "9003", price: "30" },
    };

    await assert.rejects(client.getChapterDetails(locked), /still locked.*sign in/i);
    assert.equal(requests.length, 1);
    assert.match(requests[0]!.url, /\/comics\/storm-architect\/$/);
  });

  it("loads initial and AJAX home pages and stops cleanly at the server sentinel", async () => {
    const requests = installApplication((request) => {
      if (request.url.endsWith("/")) return { body: HOME_HTML };
      if (request.body === "action=load_more_manga_posts&page=2") {
        return { body: AJAX_CARDS_HTML };
      }
      if (request.body === "action=load_more_manga_posts&page=3") {
        return { body: '{"success":false,"data":"No more posts"}' };
      }
      const body = typeof request.body === "string" ? request.body : JSON.stringify(request.body);
      throw new Error(`Unexpected request: ${body}`);
    });
    const client = new ThunderClient();

    const initial = await client.getHomeFeed("latestComics");
    const second = await client.getHomeFeed("latestComics", 2);
    const end = await client.getHomeFeed("latestComics", 3);

    assert.equal(initial.nextPage, 2);
    assert.deepEqual(
      second.items.map((item) => item.mangaId),
      ["ajax-tempest"],
    );
    assert.equal(second.nextPage, 3);
    assert.deepEqual(end, { items: [] });
    assert.equal(requests.length, 3);
  });

  it("uses structured autocomplete when title filters must be enforced client-side", async () => {
    const requests = installApplication(() => ({ body: JSON.stringify(AUTOCOMPLETE_RESPONSE) }));
    const client = new ThunderClient();

    const results = await client.getAutocompleteResults("thunder", {
      status: ["completed"],
      type: ["novel"],
      genres: { Fantasy: "included" },
    });

    assert.deepEqual(
      results.map((item) => item.mangaId),
      ["quiet-thunder-novel"],
    );
    assert.equal(requests[0]?.body, "action=ts_ac_do_search&ts_ac_query=thunder");
  });

  it("invalidates authentication-sensitive caches after login or logout", async () => {
    const requests = installApplication(() => ({ body: SERIES_HTML }));
    const client = new ThunderClient();

    await client.getMangaDetails("storm-architect");
    client.invalidateAuthenticationCaches();
    await client.getMangaDetails("storm-architect");

    assert.equal(requests.length, 2);
  });
});
