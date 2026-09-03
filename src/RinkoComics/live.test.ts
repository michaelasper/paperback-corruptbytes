import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import type { Request, Response } from "@paperback/types";

import { RinkoComicsClient } from "./client.js";
import { RinkoComicsInterceptor } from "./interceptor.js";
import { isRinkoMediaUrl } from "./network.js";

const live = process.env.RINKO_LIVE_TESTS === "1" ? it : it.skip;
const originalApplication = globalThis.Application;
const requests: Request[] = [];
const TARGET_ID = "how-to-get-on-the-main-characters-flower-path@13135";
const CHAPTER_40_ID = "how-to-get-on-the-main-characters-flower-path-chapter-40@22182";
const TITLE_DRIFT_ID = "im-stuck-in-a-crazy-drama@30";
const TITLE_DRIFT_CHAPTER_ID = "im-stuck-in-a-crazy-drama-chapter-66@274";
const FRACTIONAL_ID = "miss-pendleton@41";
const FRACTIONAL_CHAPTER_ID = "miss-pendleton-chapter-50-2@4280";
const USER_AGENT = "Mozilla/5.0 PaperbackExtensionLiveContract/1.0";
const RETRYABLE = new Set([429, 502, 503, 504, 520, 521, 522, 523, 524]);

const bodyText = (value: unknown): string => {
  if (typeof value !== "string") assert.fail("Expected a string request body.");
  return value;
};

const liveFetch = async (request: Request): Promise<globalThis.Response> => {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const headers = new Headers(request.headers);
      headers.set("user-agent", USER_AGENT);
      const response = await fetch(request.url, {
        method: request.method,
        headers,
        body: typeof request.body === "string" ? request.body : undefined,
        redirect: "follow",
        signal: AbortSignal.timeout(30_000),
      });
      if (attempt === 0 && RETRYABLE.has(response.status)) {
        await response.body?.cancel();
        continue;
      }
      return response;
    } catch (error: unknown) {
      lastError = error;
      if (attempt > 0) throw error;
    }
  }
  throw lastError;
};

before(() => {
  Object.assign(globalThis, {
    Application: {
      arrayBufferToUTF8String: (data: ArrayBuffer) => new TextDecoder().decode(data),
      scheduleRequest: async (request: Request): Promise<[Response, ArrayBuffer]> => {
        requests.push(request);
        const response = await liveFetch(request);
        return [
          {
            url: response.url,
            status: response.status,
            headers: Object.fromEntries(response.headers),
            cookies: [],
          },
          await response.arrayBuffer(),
        ];
      },
    },
  });
});

after(() => Object.assign(globalThis, { Application: originalApplication }));

describe("Rinko Comics live public contract", () => {
  live("finds the target through REST search and the live genre taxonomy", async () => {
    const client = new RinkoComicsClient();
    const [page, genres] = await Promise.all([
      client.getCatalogPage(
        { title: "How to Get on the Main Character's Flower Path" },
        undefined,
        1,
      ),
      client.getGenres(),
    ]);
    assert.ok(page.items.some((item) => item.mangaId === TARGET_ID));
    assert.ok(genres.length >= 20);
    assert.ok(genres.some((genre) => genre.id === "action"));
    assert.ok(genres.some((genre) => genre.id === "romance"));
  });

  live("supports live HTML genre filtering and sorting", async () => {
    const client = new RinkoComicsClient();
    const page = await client.getCatalogPage(
      { title: "", metadata: { genres: ["action"] } },
      { id: "az", label: "Title: A–Z" },
      1,
    );
    assert.ok(page.items.length > 0);
    assert.ok(page.items.every((item) => item.genres.includes("Action")));
  });

  live("loads every public target chapter through fresh nonce pagination", async () => {
    requests.length = 0;
    const client = new RinkoComicsClient();
    const manga = await client.getMangaDetails(TARGET_ID);
    const chapters = await client.getChapters(manga);
    assert.equal(manga.mangaInfo.primaryTitle, "How to Get on the Main Character’s Flower Path");
    assert.equal(manga.mangaInfo.status, "Ongoing");
    assert.equal(chapters.length, 40);
    const chapter40 = chapters.find((chapter) => chapter.chapterId === CHAPTER_40_ID);
    assert.ok(chapter40);
    assert.equal(chapter40.chapNum, 40);
    assert.ok(
      chapters.every((chapter) =>
        chapter.additionalInfo?.url?.startsWith("https://rinkocomics.com/chapter/"),
      ),
    );

    const posts = requests.filter((request) => request.method === "POST");
    assert.equal(posts.length, 4);
    assert.ok(posts.every((request) => request.cookies === undefined));
    assert.ok(
      posts.every((request) => request.url === "https://rinkocomics.com/wp-admin/admin-ajax.php"),
    );
    assert.deepEqual(
      posts.map((request) =>
        Number(bodyText(request.body).match(/(?:^|&)offset=(\d+)(?:&|$)/)?.[1]),
      ),
      [10, 20, 30, 40],
    );
    assert.match(bodyText(posts[0]?.body), /action=load_more_chapters.*comic_id=13135.*offset=10/);
  });

  live("accepts site-issued title drift and fractional chapter presentation", async () => {
    const client = new RinkoComicsClient();
    const titleDriftManga = await client.getMangaDetails(TITLE_DRIFT_ID);
    const titleDriftChapters = await client.getChapters(titleDriftManga);
    assert.ok(titleDriftChapters.some((chapter) => chapter.chapterId === TITLE_DRIFT_CHAPTER_ID));

    const fractionalManga = await client.getMangaDetails(FRACTIONAL_ID);
    const fractionalChapter = (await client.getChapters(fractionalManga)).find(
      (chapter) => chapter.chapterId === FRACTIONAL_CHAPTER_ID,
    );
    assert.ok(fractionalChapter);
    assert.equal(fractionalChapter.chapNum, 50.5);
    const details = await client.getChapterDetails(fractionalChapter);
    assert.ok("pages" in details);
    if (!("pages" in details)) assert.fail("Expected Rinko Comics image pages.");
    assert.equal(details.pages.length, 6);
  });

  live("revalidates and reads chapter 40 from the dedicated CDN", async () => {
    const client = new RinkoComicsClient();
    const manga = await client.getMangaDetails(TARGET_ID);
    const chapter = (await client.getChapters(manga)).find(
      (candidate) => candidate.chapterId === CHAPTER_40_ID,
    );
    assert.ok(chapter);
    const details = await client.getChapterDetails(chapter);
    assert.ok("pages" in details);
    if (!("pages" in details)) assert.fail("Expected Rinko Comics image pages.");
    assert.equal(details.pages.length, 20);
    assert.ok(details.pages.every(isRinkoMediaUrl));

    const images = await Promise.all(
      [details.pages[0]!, details.pages.at(-1)!].map((url) =>
        fetch(url, {
          headers: { "user-agent": USER_AGENT },
          signal: AbortSignal.timeout(30_000),
        }),
      ),
    );
    const interceptor = new RinkoComicsInterceptor();
    for (let index = 0; index < images.length; index += 1) {
      const image = images[index]!;
      const requestedUrl: string = index === 0 ? details.pages[0]! : details.pages.at(-1)!;
      assert.equal(image.ok, true, `${image.status} from ${image.url}`);
      assert.match(image.headers.get("content-type") ?? "", /^image\//i);
      const data = await image.arrayBuffer();
      assert.equal(
        await interceptor.interceptResponse(
          { url: requestedUrl, method: "GET" },
          {
            url: image.url,
            status: image.status,
            headers: Object.fromEntries(image.headers.entries()),
            cookies: [],
          },
          data,
        ),
        data,
      );
    }
  });

  live("resolves the canonical pasted target URL without substitution", async () => {
    const client = new RinkoComicsClient();
    const result = await client.resolvePastedUrl(
      "https://rinkocomics.com/comic/how-to-get-on-the-main-characters-flower-path/",
    );
    assert.equal(result?.items.length, 1);
    assert.equal(result?.items[0]?.mangaId, TARGET_ID);
  });
});
