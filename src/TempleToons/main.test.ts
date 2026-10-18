import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import type {
  Chapter,
  ChapterDetails,
  PagedResults,
  SearchResultItem,
  SourceManga,
} from "@paperback/types";

import { TempleExtension, type TempleClientContract } from "./main.js";
import type { TempleCatalogPage } from "./models.js";

const originalApplication = globalThis.Application;
let state = new Map<string, unknown>();

beforeEach(() => {
  state = new Map();
  Object.assign(globalThis, {
    Application: {
      Selector: (_form: unknown, method: string) => method,
      getState: (key: string) => state.get(key),
      setState: (value: unknown, key: string) => state.set(key, value),
    },
  });
});

afterEach(() => Object.assign(globalThis, { Application: originalApplication }));

const sourceManga = (mangaId: string): SourceManga => ({
  mangaId,
  mangaInfo: {
    primaryTitle: "Walk In The Night [Complete Edition]",
    secondaryTitles: [],
    thumbnailUrl: "https://templetoons.com/icon.webp",
    synopsis: "Walk In The Night [Complete Edition]",
    contentRating: "Adult" as SourceManga["mangaInfo"]["contentRating"],
  },
});

class FakeClient implements TempleClientContract {
  chapterOptions: { showLocked?: boolean; sinceDate?: Date }[] = [];

  async getCatalogPage(_page: number): Promise<TempleCatalogPage> {
    return { items: [], hasNextPage: false };
  }

  async searchComics(_term: string, _page: number): Promise<TempleCatalogPage> {
    return { items: [], hasNextPage: false };
  }

  async getMangaDetails(mangaId: string): Promise<SourceManga> {
    return sourceManga(mangaId);
  }

  async getChapters(
    _sourceManga: SourceManga,
    options: { showLocked?: boolean; sinceDate?: Date } = {},
  ): Promise<Chapter[]> {
    this.chapterOptions.push(options);
    return [];
  }

  async getChapterDetails(chapter: Chapter): Promise<ChapterDetails> {
    return { id: chapter.chapterId, mangaId: chapter.sourceManga.mangaId, pages: [] };
  }

  async resolvePastedUrl(_query: string): Promise<PagedResults<SearchResultItem> | undefined> {
    return undefined;
  }

  invalidateCaches(): void {}
}

describe("Temple extension", () => {
  it("passes locked chapter visibility and incremental dates to the client", async () => {
    const client = new FakeClient();
    const extension = new TempleExtension(client);
    const sinceDate = new Date("2026-01-01T00:00:00.000Z");
    state.set("temple_scan.show_locked_chapters", false);

    await extension.getChapters(sourceManga("walk-in-the-night"), sinceDate);

    assert.deepEqual(client.chapterOptions, [{ showLocked: false, sinceDate }]);
  });
});
