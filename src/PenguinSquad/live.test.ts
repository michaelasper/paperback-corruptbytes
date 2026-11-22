import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import type { Request, Response as PaperbackResponse, SourceManga } from "@paperback/types";

import { PenguinSquad } from "./main.js";
import { PenguinAccessError } from "./models.js";
import { encodeChapterId, encodeSeriesId } from "./network.js";

const live = process.env.PENGUIN_LIVE_TESTS === "1";
const originalApplication = globalThis.Application;
const userAgent = "Mozilla/5.0 PaperbackExtensionLiveContract/1.0";
const SERIES_SLUG = "i-married-the-dragon-i-killed";
const TARGET_CHAPTER = "chapter-281-linne-s-dream";
const MAX_CATALOG_PAGES = 12;

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

const seriesId = encodeSeriesId(SERIES_SLUG);
const targetChapterId = encodeChapterId(SERIES_SLUG, TARGET_CHAPTER);

describe("Penguin Squad live public contract", { skip: !live }, () => {
  it("traverses the catalog to its terminal page", async () => {
    const sections = await PenguinSquad.getDiscoverSections();
    assert.equal(sections.length, 1);
    const section = sections[0];
    if (!section) throw new Error("Penguin Squad catalog section is missing.");

    let metadata: { page?: number } | undefined;
    let pages = 0;
    let cards = 0;
    for (let step = 0; step < MAX_CATALOG_PAGES; step += 1) {
      const page = await PenguinSquad.getDiscoverSectionItems(section, metadata);
      pages += 1;
      if (pages === 1) {
        assert.equal(page.items.length > 0, true, "catalog page 1 is empty.");
        for (const item of page.items) {
          if (item.type !== "simpleCarouselItem") throw new Error("unexpected catalog item type.");
          assert.match(item.imageUrl, /^https:\/\//, "catalog covers must stay on HTTPS.");
          assert.equal(typeof item.mangaId, "string");
        }
      }
      cards += page.items.length;
      const next = page.metadata as { page?: number } | undefined;
      if (next?.page === undefined) {
        assert.equal(page.items.length > 0, true, "terminal catalog page is empty.");
        break;
      }
      assert.equal(next.page, pages + 1, "catalog continuation did not advance by one page.");
      metadata = next;
    }
    assert.equal(pages > 1, true, "catalog pagination did not continue.");
    assert.equal(cards > 60, true, "catalog traversal returned a single page.");
  });

  it("searches by title and resolves a pasted chapter URL", async () => {
    const results = await PenguinSquad.getSearchResults({ title: "dragon" }, undefined, undefined);
    assert.equal(results.items.length > 0, true, "search returned no results.");
    assert.equal(
      results.items.every((item) => item.imageUrl.startsWith("https://")),
      true,
    );

    const pasted = await PenguinSquad.getSearchResults(
      { title: `https://penguin-squad.com/novels/${SERIES_SLUG}/${TARGET_CHAPTER}` },
      undefined,
      undefined,
    );
    assert.equal(pasted.items.length, 1);
    assert.equal(pasted.items[0]?.mangaId, seriesId);
  });

  it("serves complete series metadata and the full chapter history", async () => {
    const manga = await PenguinSquad.getMangaDetails(seriesId);
    assert.equal(manga.mangaInfo.contentType, "novel");
    assert.equal(manga.mangaInfo.primaryTitle.length > 0, true);
    assert.equal(typeof manga.mangaInfo.author, "string", "series is missing its author.");
    assert.equal((manga.mangaInfo.tagGroups?.[0]?.tags.length ?? 0) > 0, true);
    assert.match(manga.mangaInfo.thumbnailUrl, /^https:\/\//);

    const chapters = await PenguinSquad.getChapters(manga);
    assert.equal(chapters.length > 300, true, "series history looks truncated.");
    assert.equal(new Set(chapters.map((chapter) => chapter.chapterId)).size, chapters.length);
    assert.equal(
      chapters.every((chapter) => chapter.additionalInfo?.["access"] !== undefined),
      true,
    );
    const target = chapters.find((chapter) => chapter.chapterId === targetChapterId);
    assert.ok(target, "requested chapter 281 is missing from the chapter list.");
    assert.equal(target.chapNum, 281);
    assert.equal(target.additionalInfo?.["access"], "public");
    assert.equal(target.sourceManga.mangaId, seriesId);
    assert.ok(target.publishDate instanceof Date && !Number.isNaN(target.publishDate.getTime()));
  });

  it("serves the requested public chapter as sanitized reader HTML", async () => {
    const manga = await PenguinSquad.getMangaDetails(seriesId);
    const chapters = await PenguinSquad.getChapters(manga);
    const target = chapters.find((chapter) => chapter.chapterId === targetChapterId);
    assert.ok(target);
    const details = await PenguinSquad.getChapterDetails(target);
    assert.equal(details.type, "html");
    assert.equal(details.id, targetChapterId);
    assert.equal(details.mangaId, seriesId);
    if (!("html" in details)) throw new Error("chapter details were not novel HTML.");
    assert.match(details.html, /^<html xmlns="http:\/\/www\.w3\.org\/1999\/xhtml">/);
    assert.doesNotMatch(details.html, /<script/i);
    assert.doesNotMatch(details.html, /unlock this chapter/i);
    const paragraphs = details.html.match(/<p>/g)?.length ?? 0;
    assert.equal(
      paragraphs >= 50,
      true,
      `chapter 281 returned only ${paragraphs} paragraphs, which looks like a preview.`,
    );
    assert.equal(details.html.length > 4_000, true, "chapter 281 reader content is too short.");
  });

  it("refuses the currently premium chapter without reading its page", async () => {
    const manga: SourceManga = await PenguinSquad.getMangaDetails(seriesId);
    const chapters = await PenguinSquad.getChapters(manga);
    const locked = chapters.find((chapter) => chapter.additionalInfo?.["access"] === "locked");
    assert.ok(locked, "no premium chapter was published for this series.");
    await assert.rejects(
      PenguinSquad.getChapterDetails(locked),
      (error: unknown) => error instanceof PenguinAccessError && error.reason === "locked",
    );
  });
});
