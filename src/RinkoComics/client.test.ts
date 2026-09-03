import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { runInNewContext } from "node:vm";

import type { Chapter, Request, Response, SourceManga } from "@paperback/types";

import { RinkoComicsClient } from "./client.js";
import { AJAX_URL, DOMAIN } from "./network.js";
import {
  AJAX_ROWS,
  EMPTY_AJAX_ROWS,
  GENRE_RESPONSE,
  READER_HTML,
  REST_CATALOG,
  REST_HEADERS,
  SERIES_HTML,
  SHORT_SERIES_HTML,
} from "./test-fixtures.js";

const originalApplication = globalThis.Application;
const MANGA_ID = "fixture-flower-path@900";
const CHAPTER_ID = "fixture-flower-path-chapter-12@1012";

const bodyText = (value: unknown): string => {
  if (typeof value !== "string") assert.fail("Expected a string request body.");
  return value;
};

afterEach(() => Object.assign(globalThis, { Application: originalApplication }));

interface MockReply {
  status?: number;
  headers?: Record<string, string>;
  body: string;
  url?: string;
}

const install = (route?: (request: Request) => MockReply): Request[] => {
  const requests: Request[] = [];
  Object.assign(globalThis, {
    Application: {
      arrayBufferToUTF8String: (data: ArrayBuffer) => new TextDecoder().decode(data),
      scheduleRequest: async (request: Request): Promise<[Response, ArrayBuffer]> => {
        requests.push(request);
        const reply = route?.(request) ?? defaultRoute(request);
        return [
          {
            url: reply.url ?? request.url,
            status: reply.status ?? 200,
            headers: reply.headers ?? { "content-type": "text/html; charset=UTF-8" },
            cookies: [],
          },
          new TextEncoder().encode(reply.body).buffer,
        ];
      },
    },
  });
  return requests;
};

const defaultRoute = (request: Request): MockReply => {
  if (request.url === `${DOMAIN}/comic/fixture-flower-path/`) return { body: SERIES_HTML };
  if (request.url === `${DOMAIN}/chapter/fixture-flower-path-chapter-12/`) {
    return { body: READER_HTML };
  }
  if (request.url === AJAX_URL) {
    const body = typeof request.body === "string" ? request.body : "";
    const value = body.endsWith("offset=10") ? AJAX_ROWS : EMPTY_AJAX_ROWS;
    return {
      body: JSON.stringify(value),
      headers: { "content-type": "application/json; charset=UTF-8" },
    };
  }
  if (request.url.includes("/wp-json/wp/v2/comics_genres?")) {
    return { body: JSON.stringify(GENRE_RESPONSE), headers: REST_HEADERS };
  }
  if (request.url.includes("/wp-json/wp/v2/comic?slug=fixture-flower-path")) {
    return { body: JSON.stringify([REST_CATALOG[0]]), headers: REST_HEADERS };
  }
  if (request.url.includes("/wp-json/wp/v2/comic?")) {
    return { body: JSON.stringify(REST_CATALOG), headers: REST_HEADERS };
  }
  throw new Error(`Unexpected request: ${request.method} ${request.url}`);
};

describe("Rinko Comics client", () => {
  it("assembles the complete chapter history before hiding non-public rows", async () => {
    const requests = install();
    const client = new RinkoComicsClient();
    const manga = await client.getMangaDetails(MANGA_ID);
    const chapters = await client.getChapters(manga);

    assert.equal(manga.mangaInfo.primaryTitle, "Fixture Flower Path");
    assert.equal(chapters.length, 10);
    assert.deepEqual(
      chapters.map((chapter) => chapter.chapNum),
      [1, 3, 4, 6, 7, 8, 9, 10, 11, 12],
    );
    assert.equal(chapters.at(-1)?.chapterId, CHAPTER_ID);
    assert.equal(
      chapters.some((chapter) => chapter.chapNum === 2 || chapter.chapNum === 5),
      false,
    );

    const posts = requests.filter((request) => request.url === AJAX_URL);
    assert.equal(posts.length, 2);
    assert.match(bodyText(posts[0]?.body), /offset=10$/);
    assert.match(bodyText(posts[1]?.body), /offset=20$/);
    assert.ok(posts.every((request) => request.cookies === undefined));
    assert.equal(posts[0]?.headers?.referer, `${DOMAIN}/comic/fixture-flower-path/`);
  });

  it("bounds distinct pending cache loaders before scheduler work can grow", async () => {
    let started = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    Object.assign(globalThis, {
      Application: {
        arrayBufferToUTF8String: (data: ArrayBuffer) => new TextDecoder().decode(data),
        scheduleRequest: async () => {
          started += 1;
          await gate;
          throw new Error("token=secret");
        },
      },
    });
    const client = new RinkoComicsClient();
    const attempts = Array.from({ length: 36 }, (_, index) =>
      client.getMangaDetails(`pending-series-${index}@${index + 1}`),
    );
    attempts.push(
      ...Array.from({ length: 20 }, () => client.getMangaDetails("pending-series-0@1")),
    );
    const outcomesPromise = Promise.allSettled(attempts);
    for (let turn = 0; turn < 10 && started < 16; turn += 1) await Promise.resolve();
    assert.equal(started, 16);
    release?.();
    const outcomes = await outcomesPromise;
    assert.equal(
      outcomes.filter(
        (outcome) =>
          outcome.status === "rejected" &&
          outcome.reason instanceof Error &&
          /too many concurrent cache loads/i.test(outcome.reason.message),
      ).length,
      20,
    );
    assert.ok(
      outcomes.every(
        (outcome) =>
          outcome.status === "rejected" &&
          outcome.reason instanceof Error &&
          !outcome.reason.message.includes("secret") &&
          !("cause" in outcome.reason),
      ),
    );
    install();
    assert.equal((await client.getMangaDetails(MANGA_ID)).mangaId, MANGA_ID);
  });

  it("does not spend pending-load admission on resolved warm cache hits", async () => {
    const ids = Array.from({ length: 17 }, (_, index) => `warm-series-${index}@${index + 1}`);
    const requests = install((request) => {
      const match = request.url.match(new RegExp(`^${DOMAIN}/comic/warm-series-(\\d+)/$`));
      if (!match?.[1]) return defaultRoute(request);
      const index = Number(match[1]);
      return {
        body: SERIES_HTML.replaceAll("fixture-flower-path", `warm-series-${index}`).replace(
          'data-comic-id="900"',
          `data-comic-id="${index + 1}"`,
        ),
      };
    });
    const client = new RinkoComicsClient();
    for (const id of ids) assert.equal((await client.getMangaDetails(id)).mangaId, id);
    const requestCount = requests.length;
    const outcomes = await Promise.allSettled(ids.map((id) => client.getMangaDetails(id)));
    assert.ok(outcomes.every((outcome) => outcome.status === "fulfilled"));
    assert.equal(requests.length, requestCount);
  });

  it("does not let reentrant bookkeeping restore a stale invalidated generation", async () => {
    const freshHtml = SERIES_HTML.replaceAll("Fixture Flower Path", "Fresh Flower Path");
    let requestCount = 0;
    install((request) => {
      if (request.url !== `${DOMAIN}/comic/fixture-flower-path/`) return defaultRoute(request);
      requestCount += 1;
      return { body: requestCount === 1 ? SERIES_HTML : freshHtml };
    });
    const client = new RinkoComicsClient();
    const charCodeAtDescriptor = Object.getOwnPropertyDescriptor(String.prototype, "charCodeAt");
    if (!charCodeAtDescriptor || typeof charCodeAtDescriptor.value !== "function") {
      throw new Error("String intrinsic is unavailable.");
    }
    const originalCharCodeAt = charCodeAtDescriptor.value as (index: number) => number;
    let reentered = false;
    let replacement: ReturnType<RinkoComicsClient["getMangaDetails"]> | undefined;
    String.prototype.charCodeAt = function (index: number): number {
      if (!reentered && String(this) === SERIES_HTML) {
        reentered = true;
        client.invalidateCaches();
        replacement = client.getMangaDetails(MANGA_ID);
      }
      return Reflect.apply(originalCharCodeAt, this, [index]) as number;
    };
    try {
      const first = await client.getMangaDetails(MANGA_ID);
      assert.equal(first.mangaInfo.primaryTitle, "Fixture Flower Path");
      assert.ok(replacement);
      assert.equal((await replacement).mangaInfo.primaryTitle, "Fresh Flower Path");
      assert.equal(
        (await client.getMangaDetails(MANGA_ID)).mangaInfo.primaryTitle,
        "Fresh Flower Path",
      );
      assert.equal(requestCount, 2);
    } finally {
      Object.defineProperty(String.prototype, "charCodeAt", charCodeAtDescriptor);
    }
  });

  it("accepts a validated ten-row load-more control when the full history is shorter", async () => {
    const requests = install((request) =>
      request.url === `${DOMAIN}/comic/fixture-flower-path/`
        ? { body: SHORT_SERIES_HTML }
        : defaultRoute(request),
    );
    const client = new RinkoComicsClient();
    const manga = await client.getMangaDetails(MANGA_ID);
    const chapters = await client.getChapters(manga);
    assert.deepEqual(
      chapters.map((chapter) => chapter.chapNum),
      [1, 2, 3, 4, 5, 6, 7, 8],
    );
    assert.equal(
      requests.some((request) => request.url === AJAX_URL),
      false,
    );
  });

  it("filters sinceDate only after complete validation and preserves undated rows", async () => {
    const requests = install();
    const client = new RinkoComicsClient();
    const manga = await client.getMangaDetails(MANGA_ID);
    const chapters = await client.getChapters(manga, new Date("2026-01-06T00:00:00.000Z"));
    assert.deepEqual(
      chapters.map((chapter) => chapter.chapNum),
      [7, 8, 9, 10, 11, 12],
    );
    const crossRealmDate = runInNewContext("new Date(0)") as Date;
    assert.equal((await client.getChapters(manga, crossRealmDate)).length, 10);
    const requestCount = requests.length;
    await assert.rejects(
      client.getChapters(manga, new Date(Number.NaN)),
      /date filter is invalid/i,
    );
    assert.equal(requests.length, requestCount);
  });

  it("revalidates exact public access and chapter number before returning reader pages", async () => {
    const requests = install();
    const client = new RinkoComicsClient();
    const manga = await client.getMangaDetails(MANGA_ID);
    const chapter = (await client.getChapters(manga)).at(-1)!;
    const details = await client.getChapterDetails(chapter);
    assert.equal(details.id, CHAPTER_ID);
    if (!("pages" in details)) assert.fail("Expected image pages.");
    assert.equal(details.pages.length, 2);
    assert.equal(requests.filter((request) => request.url.includes("/chapter/")).length, 1);
    assert.equal(
      requests.filter((request) => request.url === `${DOMAIN}/comic/fixture-flower-path/`).length,
      2,
    );
    assert.equal(requests.filter((request) => request.url === AJAX_URL).length, 4);

    await assert.rejects(
      client.getChapterDetails({ ...chapter, chapNum: 11 }),
      /metadata changed/i,
    );
  });

  it("binds readers to fresh site titles while preserving fractional row numbers", async () => {
    const seriesHtml = SERIES_HTML.replace(
      'data-title="Fixture Flower Path Chapter 12"',
      'data-title="Fixture flower Path Chapter 12"',
    ).replace(
      '<span class="chapter-number">Chapter 12</span>',
      '<span class="chapter-number">Chapter 12.5</span>',
    );
    const readerHtml = READER_HTML.replace(
      "Fixture Flower Path Chapter 12",
      "Fixture flower Path Chapter 12",
    );
    install((request) => {
      if (request.url === `${DOMAIN}/comic/fixture-flower-path/`) return { body: seriesHtml };
      if (request.url === `${DOMAIN}/chapter/fixture-flower-path-chapter-12/`) {
        return { body: readerHtml };
      }
      return defaultRoute(request);
    });
    const client = new RinkoComicsClient();
    const manga = await client.getMangaDetails(MANGA_ID);
    const chapter = (await client.getChapters(manga)).find(
      (candidate) => candidate.chapterId === CHAPTER_ID,
    );
    assert.ok(chapter);
    assert.equal(chapter.chapNum, 12.5);
    const details = await client.getChapterDetails(chapter);
    assert.ok("pages" in details);
    if (!("pages" in details)) assert.fail("Expected image pages.");
    assert.equal(details.pages.length, 2);
  });

  it("rejects a chapter that is no longer explicitly public", async () => {
    install((request) => {
      const reply = defaultRoute(request);
      if (request.url === `${DOMAIN}/comic/fixture-flower-path/`) {
        return { body: SERIES_HTML.replace('data-reason="free"', 'data-reason="login_required"') };
      }
      return reply;
    });
    const client = new RinkoComicsClient();
    const manga = await client.getMangaDetails(MANGA_ID);
    await assert.rejects(
      client.getChapterDetails({
        chapterId: CHAPTER_ID,
        sourceManga: manga,
        langCode: "en",
        chapNum: 12,
      }),
      /not publicly readable/i,
    );
  });

  it("resolves pasted canonical series URLs without title-search fallback", async () => {
    const requests = install();
    const client = new RinkoComicsClient();
    const result = await client.resolvePastedUrl(
      "https://rinkocomics.com/comic/fixture-flower-path/?ref=paperback",
    );
    assert.equal(result?.items[0]?.mangaId, MANGA_ID);
    assert.equal(requests.length, 1);
    assert.match(requests[0]?.url ?? "", /slug=fixture-flower-path/);
    assert.equal(await client.resolvePastedUrl("fixture flower path"), undefined);
  });

  it("loads REST catalog and every nonempty live genre deterministically", async () => {
    install();
    const client = new RinkoComicsClient();
    const page = await client.getCatalogPage({ title: "fixture" }, undefined, 1);
    const genres = await client.getGenres();
    assert.equal(page.items.length, 2);
    assert.equal(page.hasNextPage, false);
    assert.deepEqual(
      genres.map((genre) => genre.id),
      ["action", "romance"],
    );
  });

  it("maps hostile source and chapter getters to fixed source-owned errors", async () => {
    const client = new RinkoComicsClient();
    const hostile = new Proxy(
      {},
      {
        getOwnPropertyDescriptor: () => {
          throw new Error("token=secret");
        },
      },
    );
    await assert.rejects(client.getChapters(hostile as SourceManga), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "Rinko Comics source manga is invalid.");
      assert.equal(error.cause, undefined);
      return true;
    });
    await assert.rejects(client.getChapterDetails(hostile as Chapter), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "Rinko Comics chapter is invalid.");
      assert.equal(error.cause, undefined);
      return true;
    });
    await assert.rejects(client.getMangaDetails("malformed"), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "Rinko Comics source manga is invalid.");
      assert.equal(error.cause, undefined);
      return true;
    });
    await assert.rejects(
      client.getChapters({ mangaId: "malformed" } as SourceManga),
      /source manga is invalid/i,
    );
    await assert.rejects(
      client.getChapterDetails({
        chapterId: "malformed",
        chapNum: 1,
        sourceManga: { mangaId: MANGA_ID } as SourceManga,
      } as Chapter),
      /chapter is invalid/i,
    );
  });

  it("rejects incomplete chapter pagination before exposing any rows", async () => {
    install((request) => {
      const reply = defaultRoute(request);
      if (request.url === AJAX_URL) {
        return {
          body: JSON.stringify(EMPTY_AJAX_ROWS),
          headers: { "content-type": "application/json" },
        };
      }
      return reply;
    });
    const client = new RinkoComicsClient();
    const manga = await client.getMangaDetails(MANGA_ID);
    await assert.rejects(client.getChapters(manga), /incomplete chapter history/i);
  });

  it("rejects duplicate chapter rows across pagination boundaries", async () => {
    install((request) => {
      const reply = defaultRoute(request);
      if (request.url === AJAX_URL && bodyText(request.body).endsWith("offset=10")) {
        return {
          body: JSON.stringify({
            success: true,
            data: {
              html: String(AJAX_ROWS.data.html)
                .replaceAll("1002", "1012")
                .replaceAll("chapter-2", "chapter-12")
                .replace("Path Chapter 2", "Path Chapter 12")
                .replace(">Chapter 2<", ">Chapter 12<"),
            },
          }),
          headers: { "content-type": "application/json" },
        };
      }
      return reply;
    });
    const client = new RinkoComicsClient();
    const manga = await client.getMangaDetails(MANGA_ID);
    await assert.rejects(client.getChapters(manga), /conflicting chapter rows/i);
  });

  it("rejects duplicate canonical routes with different post IDs across batches", async () => {
    install((request) => {
      const reply = defaultRoute(request);
      if (request.url === AJAX_URL && bodyText(request.body).endsWith("offset=10")) {
        return {
          body: JSON.stringify({
            success: true,
            data: {
              html: String(AJAX_ROWS.data.html)
                .replaceAll("1001", "2012")
                .replaceAll("chapter-1", "chapter-12"),
            },
          }),
          headers: { "content-type": "application/json" },
        };
      }
      return reply;
    });
    const client = new RinkoComicsClient();
    const manga = await client.getMangaDetails(MANGA_ID);
    await assert.rejects(client.getChapters(manga), /conflicting chapter rows/i);
  });
});
