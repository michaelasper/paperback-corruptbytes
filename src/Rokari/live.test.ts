import { after, describe, it } from "node:test";

import type { Request, Response as PaperbackResponse } from "@paperback/types";

import { Rokari } from "./main.js";

const live = process.env.ROKARI_LIVE_TESTS === "1";
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

const sourceMangaId = "bunker-days";

describe("Rokari Comics live public contract", { skip: !live }, () => {
  it("serves its anonymous catalog and genre taxonomy", async () => {
    const sections = await Rokari.getDiscoverSections();
    if (sections.length === 0) throw new Error("Rokari returned no discover sections.");
    const latest = sections[0];
    if (!latest) throw new Error("Rokari latest section is missing.");
    const page = await Rokari.getDiscoverSectionItems(latest, undefined);
    if (page.items.length === 0) throw new Error("Rokari anonymous catalog is empty.");
    const nullPage = await Rokari.getDiscoverSectionItems(latest, null as never);
    if (nullPage.items.length === 0) throw new Error("Rokari rejects null page metadata.");
  });

  it("loads series metadata, chapters, and an accessible reader", async () => {
    const manga = await Rokari.getMangaDetails(sourceMangaId);
    if (!manga.mangaInfo.thumbnailUrl?.startsWith("https://")) {
      throw new Error("Rokari series is missing a cover.");
    }
    const chapters = await Rokari.getChapters(manga);
    if (chapters.length < 30) throw new Error("Rokari series returned an incomplete history.");
    const readable = chapters[chapters.length - 1];
    if (!readable) throw new Error("Rokari has no readable chapter candidate.");
    const reader = await Rokari.getChapterDetails(readable);
    if (!("pages" in reader) || reader.pages.length === 0) {
      throw new Error("Rokari reader returned no pages.");
    }
  });
});
