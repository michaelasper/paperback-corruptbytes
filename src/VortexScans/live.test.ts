import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import type { Request, Response } from "@paperback/types";

import {
  fetchChapterContent,
  fetchChapterList,
  fetchGenres,
  fetchPostDetails,
  fetchSearchPage,
} from "./client.js";
import {
  parseChapterDetails,
  parseChapterList,
  parseMangaDetails,
  parseMangaList,
} from "./parsers.js";

const live = process.env.VORTEX_LIVE_TESTS === "1";
const originalApplication = globalThis.Application;

const headersFrom = (headers: Headers): Record<string, string> =>
  Object.fromEntries(headers.entries());

if (live) {
  Object.assign(globalThis, {
    Application: {
      arrayBufferToUTF8String: (buffer: ArrayBuffer) => new TextDecoder().decode(buffer),
      scheduleRequest: async (request: Request): Promise<[Response, ArrayBuffer]> => {
        const response = await fetch(request.url, {
          method: request.method ?? "GET",
          headers: request.headers,
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

after(() => {
  if (live) Object.assign(globalThis, { Application: originalApplication });
});

describe("Vortex live public API", { skip: !live }, () => {
  it("searches the live catalog and loads genres", async () => {
    const [genres, response] = await Promise.all([
      fetchGenres(),
      fetchSearchPage(
        { title: "the dungeon painter", metadata: { direction: ["desc"] } },
        { id: "lastChapterAddedAt", label: "Recently updated" },
        1,
      ),
    ]);
    const results = parseMangaList(response);

    assert.ok(genres.some((genre) => genre.title === "Action"));
    assert.ok(results.some((item) => item.mangaId.startsWith("the-dungeon-painter@")));
  });

  it("reads a free chapter and rejects a current locked chapter", async () => {
    const mangaResponse = await fetchPostDetails("the-dungeon-painter");
    const manga = parseMangaDetails(mangaResponse.post ?? mangaResponse);
    const chapterResponse = await fetchChapterList(manga);
    const chapters = parseChapterList(chapterResponse, manga, { showLocked: true });

    assert.ok(chapters.length > 0, "Expected the live series to contain chapters");
    const free = chapters.find(
      (chapter) =>
        chapter.additionalInfo?.isAccessible === "true" && Boolean(chapter.additionalInfo.slug),
    );
    const locked = chapters.find(
      (chapter) =>
        chapter.additionalInfo?.isAccessible === "false" && Boolean(chapter.additionalInfo.slug),
    );
    assert.ok(free, "Expected a currently accessible chapter fixture");
    assert.ok(locked, "Expected a currently locked chapter fixture");

    const readable = parseChapterDetails(await fetchChapterContent(free), free);
    const hasReadableContent =
      ("pages" in readable && readable.pages.length > 0) ||
      (readable.type === "html" && readable.html.length > 0);
    assert.ok(hasReadableContent, "Expected nonempty reader content");

    await assert.rejects(
      async () => parseChapterDetails(await fetchChapterContent(locked), locked),
      /locked.*unlock.*Vortex/i,
    );
  });
});
