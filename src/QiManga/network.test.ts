import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import type { Request, Response } from "@paperback/types";

import {
  API_BASE_URL,
  buildBrowseUrl,
  buildChapterUrl,
  buildChaptersUrl,
  buildLatestUrl,
  buildSearchUrl,
  buildSeriesUrl,
  fetchJson,
  fetchText,
  isNeutralMediaUrl,
  parseSeriesUrl,
  seriesIdToSlug,
  seriesSlugToId,
} from "./network.js";

const originalApplication = globalThis.Application;

afterEach(() => Object.assign(globalThis, { Application: originalApplication }));

describe("Qi Manga URL contracts", () => {
  it("builds complete browse filters with the site's canonical sort IDs", () => {
    assert.equal(
      buildBrowseUrl(
        {
          title: "ignored by browse",
          metadata: { genre: "adventure-589", status: "ONGOING", type: "MANHWA" },
        },
        { id: "popular", label: "Popular" },
        3,
      ),
      `${API_BASE_URL}/series?page=3&perPage=100&genre=adventure-589&status=ONGOING&type=MANHWA&sort=popular`,
    );
    assert.equal(
      buildBrowseUrl({ title: "", metadata: { status: "CANCELLED" } }, undefined, 1),
      `${API_BASE_URL}/series?page=1&perPage=100&status=CANCELLED&sort=latest`,
    );
  });

  it("normalizes title search but never sends unsupported filter parameters", () => {
    const url = buildSearchUrl(
      {
        title: '  I’m   the "Best"  ',
        metadata: { genre: "action", status: "COMPLETED", type: "NOVEL" },
      },
      2,
    );
    assert.equal(url, `${API_BASE_URL}/series/search?page=2&perPage=100&q=I'm%20the%20%22Best%22`);
    assert.doesNotMatch(url, /genre|status|type/);
  });

  it("round-trips apostrophe-bearing IDs and encodes chapter routes", () => {
    const mangaId = seriesSlugToId("i'm-a-soldier-in-america");
    assert.equal(mangaId, "i%27m-a-soldier-in-america");
    assert.equal(seriesIdToSlug(mangaId), "i'm-a-soldier-in-america");
    assert.equal(buildSeriesUrl(mangaId), `${API_BASE_URL}/series/i%27m-a-soldier-in-america`);
    assert.equal(
      buildChaptersUrl(mangaId, 4, "desc"),
      `${API_BASE_URL}/series/i%27m-a-soldier-in-america/chapters?page=4&perPage=100&sort=desc`,
    );
    assert.equal(
      buildChapterUrl(mangaId, "chapter-2%2E5"),
      `${API_BASE_URL}/series/i%27m-a-soldier-in-america/chapters/chapter-2.5`,
    );

    const punctuated = seriesSlugToId("high-martiality:-three-thousand-emperors!");
    assert.equal(
      buildSeriesUrl(punctuated),
      `${API_BASE_URL}/series/high-martiality%3A-three-thousand-emperors%21`,
    );
  });

  it("allows only observed HTTPS media hosts", () => {
    assert.equal(isNeutralMediaUrl("https://media.qimanga.com/page.webp"), true);
    assert.equal(isNeutralMediaUrl("https://media.qiscans.org/page.webp"), true);
    assert.equal(isNeutralMediaUrl("https://media.quantumscans.org/page.webp"), true);
    assert.equal(isNeutralMediaUrl("https://qimanga.com/qiscans.ico"), false);
    assert.equal(isNeutralMediaUrl("http://media.qimanga.com/page.webp"), false);
    assert.equal(isNeutralMediaUrl("https://media.qimanga.com.evil.test/page.webp"), false);
    assert.equal(isNeutralMediaUrl("https://tracker.example/page.webp"), false);
  });

  it("parses first-party series URLs and rejects lookalike hosts and path traversal", () => {
    assert.equal(
      parseSeriesUrl("https://qimanga.com/series/i%27m-a-soldier-in-america?from=paperback"),
      "i%27m-a-soldier-in-america",
    );
    assert.equal(
      parseSeriesUrl("https://www.qimanga.com/series/the-supreme-demon-swordmaster/chapter-1"),
      "the-supreme-demon-swordmaster",
    );
    assert.equal(parseSeriesUrl("https://qimanga.com.evil.test/series/title"), undefined);
    assert.equal(parseSeriesUrl("https://qimanga.com/series/%2E%2E"), undefined);
    assert.equal(parseSeriesUrl("https://qimanga.com/series/title%2Fother"), undefined);
    assert.equal(parseSeriesUrl(`https://qimanga.com/series/${"x".repeat(2_100)}`), undefined);
  });

  it("drops corrupt filter metadata and bounds malformed search input", () => {
    assert.equal(
      buildBrowseUrl(
        {
          title: "",
          metadata: { genre: "action%2fadmin", status: "INVALID", type: "AUDIOBOOK" },
        },
        { id: "unsupported", label: "Unsupported" },
        1,
      ),
      `${API_BASE_URL}/series?page=1&perPage=100&sort=latest`,
    );
    assert.throws(() => buildSearchUrl({ title: "x".repeat(257) }, 1), /term is too long/i);
    assert.throws(() => buildSearchUrl({ title: "\ud800" }, 1), /term is invalid/i);
    assert.throws(() => buildSearchUrl({ title: "\udc00" }, 1), /term is invalid/i);
    assert.match(buildSearchUrl({ title: "hero 😀" }, 1), /q=hero%20%F0%9F%98%80/);
  });

  it("clamps invalid pages to one", () => {
    assert.equal(buildLatestUrl(Number.NaN), `${API_BASE_URL}/home/latest?page=1&perPage=40`);
    assert.equal(
      buildLatestUrl(Number.POSITIVE_INFINITY),
      `${API_BASE_URL}/home/latest?page=1&perPage=40`,
    );
  });
});

describe("Qi Manga response boundaries", () => {
  const install = (status: number, body: string, responseUrl?: string): Request[] => {
    const requests: Request[] = [];
    Object.assign(globalThis, {
      Application: {
        arrayBufferToUTF8String: (buffer: ArrayBuffer) => new TextDecoder().decode(buffer),
        scheduleRequest: async (request: Request): Promise<[Response, ArrayBuffer]> => {
          requests.push(request);
          return [
            { url: responseUrl ?? request.url, status, headers: {}, cookies: [] },
            new TextEncoder().encode(body).buffer,
          ];
        },
      },
    });
    return requests;
  };

  it("parses JSON and keeps query secrets out of malformed-response errors", async () => {
    install(200, '{"ok":true}');
    assert.deepEqual(
      await fetchJson<{ ok: boolean }>({ url: `${API_BASE_URL}/home`, method: "GET" }),
      { ok: true },
    );

    install(200, "not json");
    await assert.rejects(
      fetchJson({ url: `${API_BASE_URL}/series/search?q=secret#fragment`, method: "GET" }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /invalid JSON.*series\/search/i);
        assert.doesNotMatch(error.message, /secret|fragment/i);
        return true;
      },
    );
  });

  it("rejects HTML challenge bodies as JSON with targeted context", async () => {
    install(200, "<!doctype html><html><title>challenge</title></html>");
    await assert.rejects(
      fetchJson({ url: `${API_BASE_URL}/home`, method: "GET" }),
      /HTML instead of JSON.*\/home/i,
    );
  });

  it("rejects foreign requests and redirects before body decoding", async () => {
    const initialRequests = install(200, "private");
    await assert.rejects(
      fetchText({ url: "https://evil.example/api", method: "GET" }),
      /response URL was not trusted/i,
    );
    assert.equal(initialRequests.length, 0);

    let decodeCalls = 0;
    install(200, "private", "https://evil.example/redirected");
    Object.assign(globalThis.Application, {
      arrayBufferToUTF8String: () => {
        decodeCalls += 1;
        return "private";
      },
    });
    await assert.rejects(
      fetchText({ url: `${API_BASE_URL}/home`, method: "GET" }),
      /response URL was not trusted/i,
    );
    assert.equal(decodeCalls, 0);
  });

  it("rejects oversized documents before decoding", async () => {
    let decodeCalls = 0;
    install(200, "x".repeat(4 * 1_024 * 1_024 + 1));
    Object.assign(globalThis.Application, {
      arrayBufferToUTF8String: () => {
        decodeCalls += 1;
        return "";
      },
    });
    await assert.rejects(
      fetchText({ url: `${API_BASE_URL}/home`, method: "GET" }),
      /Qi Manga.*too large/i,
    );
    assert.equal(decodeCalls, 0);
  });
});
