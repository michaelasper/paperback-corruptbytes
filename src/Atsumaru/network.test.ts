import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import type { Request, Response } from "@paperback/types";

import {
  CDN_DOMAIN,
  DOMAIN,
  PAGE_SIZE,
  assertAtsumaruApiSuccess,
  buildAllChaptersUrl,
  buildChapterUrl,
  buildHomeUrl,
  buildMangaDocumentUrl,
  buildMangaPageUrl,
  buildNovelChapterUrl,
  buildSearchRequest,
  buildSearchUrl,
  fetchJson,
  fetchText,
  fetchTextResponse,
  parseMangaUrl,
  parseNovelUrl,
} from "./network.js";

const originalApplication = globalThis.Application;

afterEach(() => Object.assign(globalThis, { Application: originalApplication }));

describe("Atsumaru network boundaries", () => {
  it("keeps the live origin constants and page size stable", () => {
    assert.equal(DOMAIN, "https://atsu.moe");
    assert.equal(CDN_DOMAIN, "https://cdn.atsu.moe");
    assert.equal(PAGE_SIZE, 30);
  });

  it("builds the exact Typesense search contract, including every filter", () => {
    const url = buildSearchUrl(
      {
        title: "  dark   mage ",
        metadata: {
          genres: { "39": "included", "46": "excluded" },
          tags: { "tag`one": "included", "tag-two": "excluded" },
          types: ["Manga", "Manhua"],
          mediums: ["Comic"],
          statuses: ["Ongoing", "Completed"],
          contentRatings: ["Safe", "Suggestive"],
          adult: "safe",
          yearFrom: 2010,
          yearTo: 2024,
          minChapters: 10,
          officialTranslation: true,
        },
      },
      { id: "topRated", label: "Top rated" },
      2,
    );
    const query = new URLSearchParams(url.slice(url.indexOf("?") + 1));

    assert.equal(query.get("q"), "dark mage");
    assert.equal(query.get("query_by"), "title,englishTitle,otherNames,authors,acronyms");
    assert.equal(query.get("query_by_weights"), "4,3,2,1,1");
    assert.equal(query.get("num_typos"), "4,3,2,1,0");
    assert.equal(query.get("prefix"), "true,true,true,true,false");
    assert.equal(query.get("infix"), "off,off,fallback,off,off");
    assert.equal(
      query.get("include_fields"),
      "id,title,englishTitle,poster,posterSmall,posterMedium,type,medium,isAdult,status,year,mbRating,popularity,dateAdded,mbContentRating,views,releaseDate,chapterCount,officialTranslation,genreIds,tagIds,authors,otherNames,acronyms",
    );
    assert.equal(query.get("page"), "2");
    assert.equal(query.get("per_page"), String(PAGE_SIZE));
    assert.equal(
      query.get("filter_by"),
      "genreIds:=`39` && genreIds:!=[`46`] && tagIds:=`tag\\`one` && tagIds:!=[`tag-two`] && type:=[`Manga`,`Manhua`] && medium:!=[`Novel`] && status:=[`Ongoing`,`Completed`] && releaseYear:=[2010..2024] && chapterCount:>=10 && officialTranslation:=true && isAdult:=false && mbContentRating:=[`Safe`,`Suggestive`] && mbRating:>0 && hidden:!=true",
    );
    assert.equal(query.get("sort_by"), "mbRating:desc");
  });

  it("uses positive content-rating filters so missing fields cannot satisfy a selection", () => {
    const query = new URLSearchParams(
      buildSearchUrl(
        { title: "", metadata: { contentRatings: ["Pornographic"] } },
        undefined,
        1,
      ).split("?")[1],
    );

    assert.equal(
      query.get("filter_by"),
      "isAdult:=false && mbContentRating:=[`Pornographic`] && views:>0 && hidden:!=true",
    );
    assert.doesNotMatch(query.get("filter_by") ?? "", /mbContentRating:!=/);
  });

  it("uses a views sort for empty relevance queries and preserves sort aliases", () => {
    const url = buildSearchUrl({ title: "" }, undefined, 0);
    const query = new URLSearchParams(url.slice(url.indexOf("?") + 1));
    assert.equal(query.get("q"), "*");
    assert.equal(query.get("page"), "1");
    assert.equal(query.get("sort_by"), "views:desc");

    const relevance = new URLSearchParams(
      buildSearchUrl({ title: "magic" }, { id: "relevance", label: "Relevance" }, 1).split("?")[1],
    );
    assert.equal(relevance.get("sort_by"), null);

    const mostViewed = new URLSearchParams(
      buildSearchUrl({ title: "magic" }, { id: "most-viewed", label: "Most viewed" }, 1).split(
        "?",
      )[1],
    );
    assert.equal(mostViewed.get("sort_by"), "views:desc");
    assert.match(mostViewed.get("filter_by") ?? "", /views:>0/);
  });

  it("encodes the advanced-search year pair as an inclusive range", () => {
    const query = new URLSearchParams(
      buildSearchUrl({ title: "", metadata: { years: [2020, 2024] } }, undefined, 1).split("?")[1],
    );

    assert.match(query.get("filter_by") ?? "", /releaseYear:=\[2020\.\.2024\]/);
    assert.doesNotMatch(query.get("filter_by") ?? "", /releaseYear:=\[2020,2024\]/);
  });

  it("guards the live Typesense filter-operation ceiling without truncating selections", () => {
    const tags = (count: number) =>
      Object.fromEntries(
        Array.from({ length: count }, (_, index) => [`tag-${index}`, "included"]),
      ) as Record<string, "included">;

    assert.doesNotThrow(() =>
      buildSearchUrl({ title: "", metadata: { tags: tags(47) } }, undefined, 1),
    );
    assert.throws(
      () => buildSearchUrl({ title: "", metadata: { tags: tags(48) } }, undefined, 1),
      /too many.*filters|reduce.*selections/i,
    );
    assert.doesNotThrow(() =>
      buildSearchUrl({ title: "hero", metadata: { tags: tags(48) } }, undefined, 1),
    );
    assert.throws(
      () => buildSearchUrl({ title: "hero", metadata: { tags: tags(49) } }, undefined, 1),
      /too many.*filters|reduce.*selections/i,
    );
  });

  it("rejects oversized search and home query strings before the server returns 400/414", () => {
    const excluded = Array.from({ length: 300 }, (_, index) => `tag-${index}-${"long".repeat(4)}`);
    const metadata = {
      tags: Object.fromEntries(excluded.map((id) => [id, "excluded"])),
    } as { tags: Record<string, "excluded"> };

    assert.throws(
      () => buildSearchUrl({ title: "", metadata }, undefined, 1),
      /query.*too large|reduce.*selections/i,
    );
    assert.throws(
      () => buildHomeUrl("popular", { excludedTags: excluded }),
      /query.*too large|reduce.*selections/i,
    );
  });

  it("builds home feeds with bounded feed/query semantics", () => {
    assert.equal(
      buildHomeUrl("popular", {
        offset: 30,
        limit: 12,
        adult: true,
        types: ["Manga", "Manhua"],
        mediums: ["Comic"],
        excludedTags: ["250", "tag&two"],
        includedTags: ["39"],
        timeframe: "weekly",
      }),
      `${DOMAIN}/api/home2/popular?offset=30&limit=12&adult=1&types=Manga%2CManhua&mediums=Comic&excludedTags=250%2Ctag%26two&timeframe=weekly&includedTags=39`,
    );
    const legacyRatingPreference = {
      contentRatings: ["Pornographic"],
    } as unknown as Parameters<typeof buildHomeUrl>[1];
    assert.equal(
      new URL(buildHomeUrl("popular", legacyRatingPreference)).searchParams.get("contentRatings"),
      null,
    );
    const recentlyUpdated = new URL(
      buildHomeUrl("recentlyUpdated", { offset: 0, includedTags: ["39"] }),
    );
    assert.equal(recentlyUpdated.searchParams.get("includedTags"), null);
    assert.throws(() => buildHomeUrl("genreSpotlight", { offset: 0 }), /genre/i);
    assert.throws(() => buildHomeUrl("popular", { timeframe: "quarterly" as never }), /timeframe/i);
  });

  it("encodes opaque IDs without changing valid IDs and rejects path tricks", () => {
    for (const id of ["h4j-gl", "_rmrsb", "-5gIlu", "OIiM7-", "series.v2"]) {
      assert.equal(buildMangaPageUrl(id), `${DOMAIN}/api/manga/page?id=${id}`);
      assert.equal(parseMangaUrl(`${DOMAIN}/manga/${id}`), id);
      assert.equal(parseNovelUrl(`${DOMAIN}/novel/${id}/?from=paperback`), id);
    }
    assert.equal(buildMangaPageUrl("dark-%7E-mage"), `${DOMAIN}/api/manga/page?id=dark-%7E-mage`);
    assert.equal(
      buildMangaDocumentUrl("dark-%7E-mage"),
      `${DOMAIN}/collections/manga/documents/dark-%7E-mage?include_fields=id%2CmbContentRating%2CisAdult`,
    );

    for (const bad of [
      "",
      ".",
      "..",
      "a/b",
      "a?b",
      "a#b",
      "a\\b",
      "a%2Fb",
      "a\n b",
      "a\u0007b",
      "a\u007fb",
      "x".repeat(257),
    ]) {
      assert.throws(() => buildMangaPageUrl(bad), /invalid/i);
      assert.throws(() => buildMangaDocumentUrl(bad), /invalid/i);
      assert.equal(parseMangaUrl(`${DOMAIN}/manga/${encodeURIComponent(bad)}`), undefined);
    }
    assert.equal(parseMangaUrl("https://atsu.moe.evil.test/manga/h4j-gl"), undefined);
    assert.equal(parseMangaUrl("https://user:pass@atsu.moe/manga/h4j-gl"), undefined);
    assert.equal(parseMangaUrl("https://atsu.moe/manga/h4j-gl/extra"), undefined);
  });

  it("builds chapter endpoints for manga and novel routes", () => {
    assert.equal(buildAllChaptersUrl("h4j-gl"), `${DOMAIN}/api/manga/allChapters?mangaId=h4j-gl`);
    assert.equal(
      buildChapterUrl("h4j-gl", "-5gIlu"),
      `${DOMAIN}/api/read/chapter?mangaId=h4j-gl&chapterId=-5gIlu`,
    );
    assert.equal(
      buildNovelChapterUrl("_rmrsb", "OIiM7-"),
      `${DOMAIN}/api/read/novelChapter?mangaId=_rmrsb&chapterId=OIiM7-`,
    );
  });

  it("returns request objects with first-party GET endpoints", () => {
    const request = buildSearchRequest({ title: "one" }, undefined, 1);
    assert.equal(request.method, "GET");
    assert.equal(request.url, buildSearchUrl({ title: "one" }, undefined, 1));
    assert.equal(request.body, undefined);
  });
});

describe("Atsumaru response handling", () => {
  const install = (
    status: number,
    body: string,
    headers: Record<string, string> = {},
  ): Request[] => {
    const requests: Request[] = [];
    Object.assign(globalThis, {
      Application: {
        arrayBufferToUTF8String: (buffer: ArrayBuffer) => new TextDecoder().decode(buffer),
        scheduleRequest: async (request: Request): Promise<[Response, ArrayBuffer]> => {
          requests.push(request);
          return [
            { url: request.url, status, headers, cookies: [] },
            new TextEncoder().encode(body).buffer,
          ];
        },
      },
    });
    return requests;
  };

  it("decodes text, reports HTTP failures without response-body leakage, and rejects HTML JSON", async () => {
    install(200, "plain text");
    assert.equal(await fetchText({ url: `${DOMAIN}/`, method: "GET" }), "plain text");
    await assert.rejects(
      fetchJson({ url: `${DOMAIN}/api?token=secret`, method: "GET" }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /invalid JSON/i);
        assert.doesNotMatch(error.message, /token=secret/i);
        return true;
      },
    );

    install(200, "not json");
    await assert.rejects(
      fetchJson({
        url: "https://user:secret@atsu.moe/api?token=also-secret",
        method: "GET",
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /invalid JSON|trusted/i);
        assert.doesNotMatch(error.message, /user|secret|token/i);
        return true;
      },
    );

    install(200, "<html><title>Just a moment...</title></html>", {
      "content-type": "text/html",
    });
    await assert.rejects(
      fetchJson({ url: `${DOMAIN}/api?token=secret`, method: "GET" }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /Cloudflare|HTML/i);
        assert.doesNotMatch(error.message, /token=secret/i);
        return true;
      },
    );

    for (const [status, message] of [
      [404, /not found/i],
      [429, /rate limit|wait/i],
      [500, /status 500/i],
    ] as const) {
      install(status, "secret body ".repeat(1000));
      await assert.rejects(fetchText({ url: `${DOMAIN}/private`, method: "GET" }), message);
      await assert.rejects(
        fetchText({ url: `${DOMAIN}/private`, method: "GET" }),
        (error: unknown) => !(error instanceof Error && error.message.includes("secret body")),
      );
    }
  });

  it("caps untrusted response bytes before decoding and permits explicit chapter limits", async () => {
    install(200, "0123456789");
    await assert.rejects(
      fetchText({ url: `${DOMAIN}/api`, method: "GET" }, { maxBytes: 4 }),
      /too large|body limit/i,
    );
    assert.equal(
      await fetchText({ url: `${DOMAIN}/api`, method: "GET" }, { maxBytes: 32 }),
      "0123456789",
    );
  });

  it("classifies oversized rejected responses before decoding them", async () => {
    let decodeCalls = 0;
    install(401, "x".repeat(32 + 1));
    Object.assign(globalThis.Application, {
      arrayBufferToUTF8String: () => {
        decodeCalls += 1;
        return "unexpected";
      },
    });

    await assert.rejects(
      fetchTextResponse({ url: `${DOMAIN}/api`, method: "GET" }, { maxBytes: 32 }),
      /status 401/i,
    );
    assert.equal(decodeCalls, 0);
  });

  it("never schedules foreign requests and rejects redirects that leave Atsumaru", async () => {
    const requests = install(200, "ok");
    await assert.rejects(
      fetchText({ url: "https://example.com/private", method: "GET" }),
      /trusted/i,
    );
    assert.equal(requests.length, 0);

    Object.assign(globalThis, {
      Application: {
        arrayBufferToUTF8String: (buffer: ArrayBuffer) => new TextDecoder().decode(buffer),
        scheduleRequest: async (): Promise<[Response, ArrayBuffer]> => [
          { url: "https://example.com/redirected", status: 200, headers: {}, cookies: [] },
          new TextEncoder().encode("ok").buffer,
        ],
      },
    });
    await assert.rejects(fetchText({ url: `${DOMAIN}/api`, method: "GET" }), /trusted/i);
  });

  it("rejects API envelopes with success:false through a reusable helper", () => {
    assert.deepEqual(assertAtsumaruApiSuccess({ success: true, data: 1 }), {
      success: true,
      data: 1,
    });
    assert.throws(
      () => assertAtsumaruApiSuccess({ success: false, error: "Nope" }),
      /Atsumaru.*Nope/i,
    );
    assert.throws(
      () =>
        assertAtsumaruApiSuccess({
          name: "ZodError",
          message: "Unsupported genre spotlight",
        }),
      /Atsumaru.*Unsupported genre spotlight/i,
    );

    let deeplyNested: unknown = "untrusted leaf";
    for (let depth = 0; depth < 20_000; depth += 1) {
      deeplyNested = { error: deeplyNested };
    }
    assert.throws(
      () => assertAtsumaruApiSuccess({ success: false, error: deeplyNested }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(!(error instanceof RangeError));
        assert.ok(error.message.length < 500);
        return true;
      },
    );

    assert.throws(
      () => assertAtsumaruApiSuccess({ success: false, error: "line\nwith\u0007controls" }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message.includes("\n"), false);
        assert.equal(error.message.includes("\u0007"), false);
        return true;
      },
    );
  });
});
