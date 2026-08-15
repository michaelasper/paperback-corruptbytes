import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ContentRating } from "@paperback/types";

import {
  AJAX_URL,
  COMICS_URL,
  DOMAIN,
  buildAutocompleteRequest,
  buildLoadMoreRequest,
  buildMangaUrl,
} from "./network.js";
import {
  parseAutocompleteResults,
  parseChapterDetails,
  parseChapterList,
  parseDirectoryPage,
  parseGenres,
  parseHomeFeed,
  parseMangaDetails,
} from "./parsers.js";

const live = process.env.THUNDER_LIVE_TESTS === "1" ? it : it.skip;
const headers = {
  "user-agent": "Mozilla/5.0 PaperbackExtensionLiveContract/1.0",
  accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
};

const requestText = async (url: string, init?: RequestInit): Promise<string> => {
  const requestHeaders = new Headers(headers);
  new Headers(init?.headers).forEach((value, name) => requestHeaders.set(name, value));
  const response = await fetch(url, {
    ...init,
    headers: requestHeaders,
    redirect: "follow",
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(response.ok, true, `${response.status} from ${response.url}`);
  return response.text();
};

const formBody = (request: { body?: ArrayBuffer | object | string }): string => {
  assert.equal(typeof request.body, "string");
  return request.body as string;
};

describe("Thunder live public contract", () => {
  live("parses every homepage feed and both independent cursors", async () => {
    const html = await requestText(`${DOMAIN}/`);
    const popular = parseHomeFeed(html, "popular");
    const editors = parseHomeFeed(html, "editors");
    const comics = parseHomeFeed(html, "latestComics");
    const novels = parseHomeFeed(html, "latestNovels");

    assert.ok(popular.items.length > 0);
    assert.ok(editors.items.length > 0);
    assert.ok(comics.items.length > 0);
    assert.ok(novels.items.length > 0);
    assert.ok(comics.nextPage && comics.nextPage >= 2);
    assert.ok(novels.nextPage && novels.nextPage >= 2);

    const request = buildLoadMoreRequest("latestComics", comics.nextPage);
    const fragment = await requestText(AJAX_URL, {
      method: "POST",
      headers: request.headers,
      body: formBody(request),
    });
    assert.ok(parseDirectoryPage(`<div class="listupd">${fragment}</div>`).items.length > 0);
  });

  live("parses the directory taxonomy, details, stable chapters, and a public reader", async () => {
    const directoryHtml = await requestText(COMICS_URL);
    const directory = parseDirectoryPage(directoryHtml);
    const genres = parseGenres(directoryHtml);
    assert.ok(directory.items.length >= 10);
    assert.ok(genres.length >= 25);

    const selected = directory.items[0]!;
    const seriesHtml = await requestText(buildMangaUrl(selected.mangaId));
    const manga = parseMangaDetails(seriesHtml, selected.mangaId);
    const chapters = parseChapterList(seriesHtml, manga, { showLocked: true });
    assert.equal(manga.mangaId, selected.mangaId);
    assert.ok(manga.mangaInfo.primaryTitle.length > 0);
    assert.ok(chapters.length > 0);
    assert.ok(chapters.every((chapter) => /^\d+(?:\.\d+)?$/.test(chapter.chapterId)));

    const accessible = chapters.find((chapter) => chapter.additionalInfo?.url);
    assert.ok(accessible, "Expected at least one public or purchased-looking chapter URL");
    const readerHtml = await requestText(accessible.additionalInfo!.url!);
    const details = parseChapterDetails(readerHtml, accessible);
    if (details.type === "html") assert.ok(details.html.length > 100);
    else if (details.type === "file") assert.fail("Expected an image or novel chapter");
    else assert.ok(details.pages.length > 0);
  });

  live("parses structured autocomplete without trusting foreign links", async () => {
    const request = buildAutocompleteRequest("wizard");
    const body = await requestText(AJAX_URL, {
      method: "POST",
      headers: request.headers,
      body: formBody(request),
    });
    const results = parseAutocompleteResults(JSON.parse(body));

    assert.ok(results.length > 0);
    assert.ok(results.every((item) => item.mangaId && item.imageUrl.startsWith("http")));
    assert.ok(
      results.every((item) =>
        [ContentRating.EVERYONE, ContentRating.MATURE, ContentRating.ADULT].includes(
          item.contentRating,
        ),
      ),
    );
  });

  live("returns real novel chapters as sanitized HTML", async () => {
    const home = await requestText(`${DOMAIN}/`);
    const novel = parseHomeFeed(home, "latestNovels").items.find(
      (item) => item.latestChapterId !== undefined,
    );
    assert.ok(novel, "Expected a novel advertising at least one chapter");
    const seriesHtml = await requestText(buildMangaUrl(novel.mangaId));
    const manga = parseMangaDetails(seriesHtml, novel.mangaId);
    assert.equal(manga.mangaInfo.contentType, "novel");
    const chapter = parseChapterList(seriesHtml, manga, { showLocked: false }).at(-1);
    assert.ok(chapter?.additionalInfo?.url);

    const details = parseChapterDetails(await requestText(chapter.additionalInfo.url), chapter);
    assert.equal(details.type, "html");
    if (details.type !== "html") assert.fail("Expected a novel HTML chapter");
    assert.match(details.html, /^<html xmlns=/);
    assert.doesNotMatch(details.html, /<(?:script|iframe|form)\b/i);
  });
});
