import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ContentRating, type SourceManga } from "@paperback/types";

import { buildBrowseUrl, buildChapterUrl, buildChaptersUrl, buildMangaUrl } from "./network.js";
import {
  parseBrowseCards,
  parseBrowseResponse,
  parseChapterDetails,
  parseChapters,
  parseFilterOptions,
  parseMangaDetails,
} from "./parsers.js";

const live = process.env.MGEKO_LIVE_TESTS === "1" ? it : it.skip;
const headers = {
  "user-agent": "Mozilla/5.0 PaperbackExtensionLiveContract/1.0",
  accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
};

const requestText = async (url: string): Promise<string> => {
  const response = await fetch(url, {
    headers,
    redirect: "follow",
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(response.ok, true, `${response.status} from ${response.url}`);
  return response.text();
};

describe("Mgeko live public contract", () => {
  live("uses the complete safe browse API and live taxonomy", async () => {
    const [filterHtml, responseBody] = await Promise.all([
      requestText("https://www.mgeko.cc/browse-comics/"),
      requestText(
        buildBrowseUrl(
          { title: "assassin", metadata: { genres: { Action: "included" } } },
          { id: "latest", label: "Recently updated" },
          1,
          true,
        ),
      ),
    ]);
    const filters = parseFilterOptions(filterHtml);
    const envelope = parseBrowseResponse(JSON.parse(responseBody));
    const cards = parseBrowseCards(envelope.resultsHtml, { safeMode: true });

    assert.ok(filters.genres.length >= 30);
    assert.ok(filters.statuses.some((item) => item.id === "completed"));
    assert.ok(filters.types.some((item) => item.id === "manhwa"));
    assert.ok(cards.length > 0);
    assert.ok(cards.every((item) => item.contentRating !== ContentRating.ADULT));
  });

  live(
    "preserves an archived series ID, fractional chapter IDs, and live reader pages",
    async () => {
      const mangaId = "the-reincarnated-assassin-is-a-genius-swordsman";
      const [seriesHtml, chapterHtml] = await Promise.all([
        requestText(buildMangaUrl(mangaId)),
        requestText(buildChaptersUrl(mangaId)),
      ]);
      const manga = parseMangaDetails(seriesHtml, mangaId);
      const chapters = parseChapters(chapterHtml, manga);

      assert.equal(manga.mangaId, mangaId);
      assert.ok(chapters.length >= 90);
      assert.ok(chapters.every((chapter) => !chapter.chapterId.includes("/")));
      const archivedChapter = chapters.find(
        (chapter) =>
          chapter.chapterId === "the-reincarnated-assassin-is-a-genius-swordsman-chapter-15-eng-li",
      );
      assert.ok(archivedChapter);

      const reader = parseChapterDetails(
        await requestText(buildChapterUrl(archivedChapter.chapterId)),
        archivedChapter,
      );
      assert.ok("pages" in reader && reader.pages.length >= 15);
      if (!("pages" in reader)) assert.fail("Expected an image chapter");
      const imageResponse = await fetch(reader.pages[0]!, {
        headers: { "user-agent": headers["user-agent"] },
        signal: AbortSignal.timeout(15_000),
      });
      assert.equal(imageResponse.ok, true);
      assert.match(imageResponse.headers.get("content-type") ?? "", /^image\//);
    },
  );

  live("returns no fabricated dates when a chapter date is absent", async () => {
    const sourceManga: SourceManga = {
      mangaId: "missing-date-contract",
      mangaInfo: {
        primaryTitle: "Fixture",
        secondaryTitles: [],
        thumbnailUrl: "https://www.mgeko.cc/favicon.ico",
        synopsis: "",
        contentRating: ContentRating.MATURE,
      },
    };
    const chapter = parseChapters(
      '<ul class="chapter-list"><li><a href="/reader/en/missing-date-contract-chapter-1-eng-li/"><strong class="chapter-title">1-eng-li</strong></a></li></ul>',
      sourceManga,
    )[0];
    assert.equal(chapter?.publishDate, undefined);
  });
});
