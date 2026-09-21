import { after, describe, it } from "node:test";

import type { Request, Response as PaperbackResponse } from "@paperback/types";

import { Temple } from "./main.js";

const live = process.env.TEMPLE_LIVE_TESTS === "1";
const originalApplication = globalThis.Application;
const userAgent = "Mozilla/5.0 PaperbackExtensionLiveContract/1.0";

if (live) {
  Object.assign(globalThis, {
    Application: {
      arrayBufferToUTF8String: (buffer: ArrayBuffer): string => new TextDecoder().decode(buffer),
      scheduleRequest: async (request: Request): Promise<[PaperbackResponse, ArrayBuffer]> => {
        const headers = new Headers(request.headers);
        headers.set("user-agent", userAgent);
        const response = await fetch(request.url, {
          method: request.method ?? "GET",
          headers,
          body: typeof request.body === "string" ? request.body : undefined,
          redirect: "follow",
          signal: AbortSignal.timeout(20_000),
        });
        return [
          {
            url: response.url,
            status: response.status,
            headers: Object.fromEntries(response.headers.entries()),
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

// The search API is bot accessible everywhere. Series and chapter HTML pages sit
// behind the site Turnstile wall, so the second case needs residential egress or
// Paperback Cloudflare bypass cookies. It was verified through a cleared browser.
const sourceMangaId = "walk-in-the-night";

describe("Temple Scan live public contract", { skip: !live }, () => {
  it("serves its anonymous catalog through the search API", async () => {
    const page = await Temple.getSearchResults({ title: "walk in the night" }, undefined);
    if (page.items.length === 0) throw new Error("Temple search returned no results.");
    const match = page.items.find((item) => item.mangaId === sourceMangaId);
    if (!match) throw new Error("Temple search did not return the expected series.");
  });

  it("loads series metadata, chapters, and an accessible reader", async () => {
    const manga = await Temple.getMangaDetails(sourceMangaId);
    if (!manga.mangaInfo.thumbnailUrl?.startsWith("https://")) {
      throw new Error("Temple series is missing a cover.");
    }
    const chapters = await Temple.getChapters(manga);
    if (chapters.length === 0) throw new Error("Temple series returned no chapters.");
    const free = chapters.filter((chapter) => chapter.additionalInfo?.locked !== "true");
    if (free.length === 0) throw new Error("Temple series has no free chapters.");
    const candidate = free[free.length - 1];
    if (!candidate) throw new Error("Temple has no readable chapter candidate.");
    const reader = await Temple.getChapterDetails(candidate);
    if (!("pages" in reader) || reader.pages.length === 0) {
      throw new Error("Temple reader returned no pages.");
    }
  });
});
