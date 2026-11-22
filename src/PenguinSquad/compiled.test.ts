import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { runInThisContext } from "node:vm";

import type {
  Chapter,
  Request,
  Response as PaperbackResponse,
  SourceManga,
} from "@paperback/types";
import { build } from "rolldown";

import { encodeChapterId, encodeSeriesId } from "./network.js";
import {
  PENGUIN_SERIES_SLUG,
  PENGUIN_SERIES_TITLE,
  catalogHtml,
  chapterHtml,
  searchHtml,
  seriesHtml,
} from "./test-fixtures.js";

const DOMAIN = "https://penguin-squad.com";
const seriesId = encodeSeriesId(PENGUIN_SERIES_SLUG);
const seriesUrl = `${DOMAIN}/novels/${PENGUIN_SERIES_SLUG}`;

interface CompiledSource {
  initialise(): Promise<void>;
  getDiscoverSectionItems(
    section: unknown,
    metadata?: unknown,
  ): Promise<{
    items: { mangaId: string; title: string }[];
    metadata?: unknown;
  }>;
  getMangaDetails(mangaId: string): Promise<SourceManga>;
  getChapters(manga: SourceManga, sinceDate?: Date): Promise<Chapter[]>;
  getChapterDetails(
    chapter: Chapter,
  ): Promise<{ type?: string; html?: string; id: string; mangaId: string }>;
  getSearchResults(
    query: { title: string },
    metadata?: unknown,
    sortingOption?: unknown,
  ): Promise<{ items: { mangaId: string; title: string }[] }>;
}

const fixtures = (): Record<string, string> => ({
  [`${DOMAIN}/novels`]: catalogHtml({ count: 60 }),
  [`${DOMAIN}/novels?page=2`]: catalogHtml({ page: 2, count: 60 }),
  [`${DOMAIN}/novels?page=5`]: catalogHtml({ page: 5, count: 5 }),
  [`${DOMAIN}/search?q=dragon`]: searchHtml({ term: "dragon", count: 5 }),
  [seriesUrl]: seriesHtml(),
  [`${seriesUrl}/chapter-3-synthetic-part-3`]: chapterHtml(),
});

let source: CompiledSource;
let registrations: string[];
let requests: string[];
const originalApplication = globalThis.Application;

const application = (routes: Record<string, string>) => ({
  getDefaultUserAgent: async () => "Mozilla/5.0 PaperbackExtensionCompiled/1.0",
  getState: () => undefined,
  getSecureState: () => undefined,
  setState: () => {},
  setSecureState: () => {},
  registerInterceptor: (name: string) => {
    assert.equal(registrations.includes(name), false, `duplicate interceptor ${name}`);
    registrations.push(name);
  },
  Selector: (owner: Record<string, unknown>, method: string) => {
    assert.equal(typeof owner[method], "function", `invalid selector ${method}`);
    return () => {};
  },
  arrayBufferToUTF8String: (buffer: ArrayBuffer) => new TextDecoder().decode(buffer),
  scheduleRequest: async (request: Request): Promise<[PaperbackResponse, ArrayBuffer]> => {
    requests.push(request.url);
    const body = routes[request.url];
    if (body === undefined) throw new Error(`Unexpected request ${request.url}`);
    return [
      {
        url: request.url,
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
        cookies: [],
      },
      new TextEncoder().encode(body).buffer as ArrayBuffer,
    ];
  },
});

before(async () => {
  const result = await build({
    input: new URL("./main.ts", import.meta.url).pathname,
    transform: { target: "es2020" },
    output: { format: "iife", name: "source", minify: true },
    write: false,
  });
  const code = result.output[0]?.code;
  assert.equal(typeof code, "string");
  registrations = [];
  requests = [];
  globalThis.Application = application(fixtures()) as unknown as typeof globalThis.Application;
  const exports = runInThisContext(`${code}\n;source;`) as { PenguinSquad?: CompiledSource };
  assert.ok(exports.PenguinSquad, "compiled bundle did not expose the PenguinSquad instance");
  source = exports.PenguinSquad;
  await source.initialise();
});

after(() => {
  globalThis.Application = originalApplication;
});

describe("compiled Penguin Squad export", () => {
  it("registers its transport interceptors on initialise", () => {
    assert.equal(registrations.length >= 2, true);
  });

  it("pages the catalog by server continuation", async () => {
    const first = await source.getDiscoverSectionItems({ id: "catalog" }, undefined);
    assert.equal(first.items.length, 60);
    assert.deepEqual(first.metadata, { page: 2 });
    const second = await source.getDiscoverSectionItems({ id: "catalog" }, first.metadata as never);
    assert.equal(second.items[0]?.title, "Synthetic Series 200");
    const terminal = await source.getDiscoverSectionItems({ id: "catalog" }, { page: 5 } as never);
    assert.equal(terminal.items.length, 5);
    assert.equal(terminal.metadata, undefined);
  });

  it("keeps chapter 281-style identity and association through the compiled adapter", async () => {
    const manga = await source.getMangaDetails(seriesId);
    assert.equal(manga.mangaInfo.primaryTitle, PENGUIN_SERIES_TITLE);
    assert.equal(manga.mangaInfo.contentType, "novel");
    const chapters = await source.getChapters(manga);
    assert.equal(chapters.length, 4);
    const publicChapter = chapters.find((chapter) => chapter.chapNum === 3);
    assert.ok(publicChapter);
    assert.equal(
      publicChapter.chapterId,
      encodeChapterId(PENGUIN_SERIES_SLUG, "chapter-3-synthetic-part-3"),
    );
    assert.equal(publicChapter.sourceManga.mangaId, seriesId);
    const details = await source.getChapterDetails(publicChapter);
    assert.equal(details.type, "html");
    assert.equal(details.id, publicChapter.chapterId);
    assert.equal(details.mangaId, seriesId);
    assert.match(details.html ?? "", /Synthetic paragraph 1\./);
  });

  it("refuses a premium chapter from the compiled adapter", async () => {
    const manga = await source.getMangaDetails(seriesId);
    const chapters = await source.getChapters(manga);
    const locked = chapters.find((chapter) => chapter.chapNum === 4);
    assert.ok(locked);
    await assert.rejects(source.getChapterDetails(locked), (error: unknown) => {
      assert.equal((error as Error).name, "PenguinAccessError");
      return true;
    });
    assert.equal(
      requests.some((url) => url.includes("chapter-4")),
      false,
      "a premium chapter page was requested",
    );
  });

  it("searches through the compiled adapter", async () => {
    const results = await source.getSearchResults({ title: "dragon" });
    assert.equal(results.items.length, 5);
    assert.equal(results.items[0]?.mangaId, "synthetic-series-200");
  });
});
