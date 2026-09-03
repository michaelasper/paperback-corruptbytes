import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import type { Request, Response } from "@paperback/types";

import {
  AJAX_URL,
  CDN_DOMAIN,
  DOMAIN,
  MAX_CHAPTER_BATCHES,
  MAX_CHAPTERS,
  MAX_CONCURRENT_REQUESTS,
  buildArchiveCatalogRequest,
  buildChapterAjaxRequest,
  buildChapterUrl,
  buildGenreRequest,
  buildRestCatalogRequest,
  buildSeriesLookupRequest,
  buildSeriesUrl,
  canonicalChapterSlug,
  decodeRinkoChapterId,
  decodeRinkoMangaId,
  encodeRinkoChapterId,
  encodeRinkoMangaId,
  fetchHtml,
  fetchJsonResponse,
  isRinkoCoverUrl,
  isRinkoImageContentType,
  isRinkoMediaUrl,
  isRinkoReadUrl,
  isRinkoSiteUrl,
  normalizePageNumber,
  normalizeRinkoSearchQuery,
  normalizeSearchTerm,
  parseJsonDocument,
  parseSeriesUrl,
} from "./network.js";

const originalApplication = globalThis.Application;

afterEach(() => Object.assign(globalThis, { Application: originalApplication }));

const install = (
  options: {
    status?: number;
    body?: string;
    headers?: Record<string, string>;
    responseUrl?: string;
    data?: ArrayBuffer;
  } = {},
): Request[] => {
  const requests: Request[] = [];
  Object.assign(globalThis, {
    Application: {
      arrayBufferToUTF8String: (data: ArrayBuffer) => new TextDecoder().decode(data),
      scheduleRequest: async (request: Request): Promise<[Response, ArrayBuffer]> => {
        requests.push(request);
        return [
          {
            url: options.responseUrl ?? request.url,
            status: options.status ?? 200,
            headers: options.headers ?? { "content-type": "text/html; charset=UTF-8" },
            cookies: [],
          },
          options.data ?? new TextEncoder().encode(options.body ?? "<html></html>").buffer,
        ];
      },
    },
  });
  return requests;
};

describe("Rinko Comics URL contracts", () => {
  it("round-trips canonical composite series and chapter IDs", () => {
    const mangaId = encodeRinkoMangaId("flower-path", 13135);
    const chapterId = encodeRinkoChapterId("flower-path-chapter-40", "22182");
    assert.equal(mangaId, "flower-path@13135");
    assert.equal(chapterId, "flower-path-chapter-40@22182");
    assert.deepEqual(decodeRinkoMangaId(mangaId), { slug: "flower-path", postId: "13135" });
    assert.deepEqual(decodeRinkoChapterId(chapterId), {
      slug: "flower-path-chapter-40",
      postId: "22182",
    });
    assert.equal(buildSeriesUrl(mangaId), `${DOMAIN}/comic/flower-path/`);
    assert.equal(buildChapterUrl(chapterId), `${DOMAIN}/chapter/flower-path-chapter-40/`);
    assert.throws(() => decodeRinkoMangaId("flower-path"), /series ID is invalid/i);
    assert.throws(() => decodeRinkoMangaId("flower-path@01"), /series ID is invalid/i);
    assert.throws(() => decodeRinkoChapterId("..@1"), /chapter ID is invalid/i);
    assert.throws(() => decodeRinkoChapterId("chapter\u200bhidden@1"), /chapter ID is invalid/i);
    assert.throws(() => decodeRinkoMangaId(`${"x".repeat(257)}@1`), /series ID is invalid/i);
  });

  it("recognizes only canonical Rinko series URLs and rejects traversal", () => {
    assert.equal(
      parseSeriesUrl("https://rinkocomics.com/comic/flower-path/?from=paperback"),
      "flower-path",
    );
    assert.equal(
      parseSeriesUrl("https://rinkocomics.com/comic/flower-path/?from=paperback#reader"),
      undefined,
    );
    assert.equal(parseSeriesUrl(" https://rinkocomics.com/comic/flower-path/"), undefined);
    assert.equal(parseSeriesUrl("https://rinkocomics.com/comic/flower\n-path/"), undefined);
    assert.equal(parseSeriesUrl("https://rinkocomics.com/comic/flower\u2028-path/"), undefined);
    assert.equal(parseSeriesUrl("http://www.rinkocomics.com/comic/flower-path/"), "flower-path");
    assert.equal(parseSeriesUrl("https://rinkocomics.com.evil.test/comic/flower-path/"), undefined);
    assert.equal(parseSeriesUrl("https://rinkocomics.com/chapter/flower-path/"), undefined);
    assert.equal(parseSeriesUrl("https://rinkocomics.com/comic/%2e%2e/"), undefined);
    assert.equal(parseSeriesUrl("https://rinkocomics.com/comic/one%2Ftwo/"), undefined);
    assert.equal(parseSeriesUrl("https://rinkocomics.com/comic/one%252fadmin/"), undefined);
    assert.equal(parseSeriesUrl("https://rinkocomics.com/comic/%2500/"), undefined);
    assert.equal(parseSeriesUrl("https://rinkocomics.com/comic/%250A/"), undefined);
    assert.equal(parseSeriesUrl("https://rinkocomics.com/comic/%25E2%2580%258B/"), undefined);
    assert.equal(parseSeriesUrl(`https://rinkocomics.com/comic/${"x".repeat(2_100)}/`), undefined);
  });

  it("builds bounded REST and complete archive searches", () => {
    assert.equal(
      buildRestCatalogRequest("  Flower   Path  ", 2).url,
      `${DOMAIN}/wp-json/wp/v2/comic?per_page=20&page=2&search=Flower%20Path&_embed=wp%3Afeaturedmedia%2Cwp%3Aterm`,
    );
    assert.equal(
      buildRestCatalogRequest("Character's Path", 1).url,
      `${DOMAIN}/wp-json/wp/v2/comic?per_page=20&page=1&search=Character%20s%20Path&_embed=wp%3Afeaturedmedia%2Cwp%3Aterm`,
    );
    assert.equal(
      buildArchiveCatalogRequest(
        { title: "hero", metadata: { genres: ["romance", "action"] } },
        { id: "az", label: "Title: A–Z" },
        3,
      ).url,
      `${DOMAIN}/comic/page/3/?post_type=comic&s=hero&genres%5B%5D=action&genres%5B%5D=romance&sort=az`,
    );
    assert.equal(buildSeriesLookupRequest("flower-path").method, "GET");
    assert.throws(
      () =>
        buildArchiveCatalogRequest({ title: "", metadata: { genres: [" action "] } }, undefined, 1),
      /genre filters are invalid/i,
    );
    assert.throws(
      () => buildArchiveCatalogRequest({ title: "" }, { id: "popular", label: "Popular" }, 1),
      /sorting option is invalid/i,
    );
    assert.throws(
      () =>
        buildArchiveCatalogRequest(
          { title: "" },
          { id: "az", label: "Title: A–Z", token: "secret" } as never,
          1,
        ),
      /sorting option is invalid/i,
    );
    const hiddenSort = Object.defineProperty({ id: "az", label: "Title: A–Z" }, "token", {
      value: "secret",
      enumerable: false,
    });
    assert.throws(
      () => buildArchiveCatalogRequest({ title: "" }, hiddenSort, 1),
      /sorting option is invalid/i,
    );
  });

  it("accepts only canonical source-emitted first-party read URLs", () => {
    const urls = [
      buildRestCatalogRequest("Character's Path", 2).url,
      buildGenreRequest(1).url,
      buildSeriesLookupRequest("flower-path").url,
      buildArchiveCatalogRequest(
        { title: "hero", metadata: { genres: ["romance", "action"] } },
        { id: "az", label: "Title: A–Z" },
        3,
      ).url,
      buildSeriesUrl("flower-path@13135"),
      buildChapterUrl("flower-path-chapter-40@22182"),
      `${DOMAIN}/wp-content/uploads/2026/01/cover.webp`,
    ];
    assert.ok(urls.every(isRinkoReadUrl));
    assert.equal(isRinkoReadUrl(`${DOMAIN}/wp-login.php`), false);
    assert.equal(isRinkoReadUrl(`${urls[0]}&token=secret`), false);
    assert.equal(isRinkoReadUrl(`${DOMAIN}/comic/page/03/?sort=az`), false);
    assert.equal(isRinkoReadUrl(`${DOMAIN}/comic/%2500/`), false);
    assert.equal(isRinkoReadUrl(`${DOMAIN}/chapter/%250A/`), false);
    assert.equal(isRinkoReadUrl(`${DOMAIN}/comic/%25E2%2580%258B/`), false);
  });

  it("rejects malformed and oversized search terms before encoding", () => {
    assert.equal(normalizeSearchTerm("  I’m   ready  "), "I m ready");
    assert.throws(() => normalizeSearchTerm("x".repeat(257)), /too long/i);
    assert.throws(() => normalizeSearchTerm(" ".repeat(4_097)), /too long/i);
    assert.throws(() => normalizeSearchTerm("x\u0000admin"), /invalid/i);
    assert.throws(() => normalizeSearchTerm("x\nadmin"), /invalid/i);
    assert.throws(() => normalizeSearchTerm("x\u200badmin"), /invalid/i);
    assert.throws(() => normalizeSearchTerm("x\uffff"), /invalid/i);
    assert.throws(() => normalizeSearchTerm("\ud800"), /invalid/i);
    assert.deepEqual(
      normalizeRinkoSearchQuery({
        title: "  Hero's Path  ",
        metadata: { genres: ["romance", "action"] },
      }),
      { title: "Hero s Path", metadata: { genres: ["action", "romance"] } },
    );
    assert.throws(
      () => normalizeRinkoSearchQuery({ title: "", metadata: { genres: ["action", "action"] } }),
      /genre filters are invalid/i,
    );
    assert.throws(
      () =>
        normalizeRinkoSearchQuery({
          title: "",
          metadata: { genres: Array.from({ length: 8 }, (_, index) => `genre-${index}`) },
        }),
      /genre filters are invalid/i,
    );
    const hiddenQuery = Object.defineProperty({ title: "" }, "token", {
      value: "secret",
      enumerable: false,
    });
    assert.throws(() => normalizeRinkoSearchQuery(hiddenQuery), /search query is invalid/i);
    const hiddenMetadata = Object.defineProperty({ genres: ["action"] }, "token", {
      value: "secret",
      enumerable: false,
    });
    assert.throws(
      () => normalizeRinkoSearchQuery({ title: "", metadata: hiddenMetadata }),
      /search query is invalid/i,
    );
    const symbolQuery = { title: "" } as { [key: PropertyKey]: unknown };
    Object.defineProperty(symbolQuery, Symbol("token"), { value: "secret", enumerable: true });
    assert.throws(() => normalizeRinkoSearchQuery(symbolQuery), /search query is invalid/i);
    const hiddenGenres = Object.defineProperty(["action"], "token", {
      value: "secret",
      enumerable: false,
    });
    assert.throws(
      () => normalizeRinkoSearchQuery({ title: "", metadata: { genres: hiddenGenres } }),
      /genre filters are invalid/i,
    );
    const symbolGenres = ["action"];
    Object.defineProperty(symbolGenres, Symbol("token"), { value: "secret", enumerable: true });
    assert.throws(
      () => normalizeRinkoSearchQuery({ title: "", metadata: { genres: symbolGenres } }),
      /genre filters are invalid/i,
    );
    const hostile = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error("token=secret");
        },
      },
    );
    assert.throws(
      () => normalizeRinkoSearchQuery(hostile),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, "Rinko Comics search query is invalid.");
        assert.equal(error.cause, undefined);
        return true;
      },
    );
    const hostileGenres = new Proxy<string[]>([], {
      ownKeys() {
        throw new Error("token=secret");
      },
    });
    assert.throws(
      () => normalizeRinkoSearchQuery({ title: "", metadata: { genres: hostileGenres } }),
      (error: unknown) =>
        error instanceof Error &&
        error.message === "Rinko Comics genre filters are invalid." &&
        !("cause" in error),
    );
    assert.throws(() => normalizePageNumber(Number.NaN), /catalog page is invalid/i);
    assert.throws(() => normalizePageNumber(1.5), /catalog page is invalid/i);
    assert.throws(() => normalizePageNumber(10_000), /catalog page is invalid/i);
  });

  it("allowlists document, cover, and reader origins exactly", () => {
    assert.equal(isRinkoSiteUrl(`${DOMAIN}/comic/flower-path/`), true);
    assert.equal(isRinkoSiteUrl("https://www.rinkocomics.com/comic/flower-path/"), false);
    assert.equal(isRinkoSiteUrl("http://rinkocomics.com/comic/flower-path/"), false);
    assert.equal(isRinkoSiteUrl(` ${DOMAIN}/comic/flower-path/`), false);
    assert.equal(isRinkoSiteUrl(`${DOMAIN}/comic/flower\n-path/`), false);
    assert.equal(isRinkoSiteUrl(`${DOMAIN}/comic/flower\u2028-path/`), false);
    assert.equal(isRinkoSiteUrl("https://rinkocomics.com.evil.test/"), false);
    assert.equal(isRinkoSiteUrl(`${DOMAIN}/#`), false);
    assert.equal(isRinkoCoverUrl(`${DOMAIN}/wp-content/uploads/2026/01/cover.webp`), true);
    assert.equal(isRinkoCoverUrl(`${DOMAIN}/login`), false);
    assert.equal(isRinkoCoverUrl(`${DOMAIN}/wp-content/uploads/2026/01/cover.php`), false);
    assert.equal(
      isRinkoMediaUrl(`${CDN_DOMAIN}/wp-content/uploads/comics/flower-path/40/01.webp`),
      true,
    );
    assert.equal(isRinkoMediaUrl(`${CDN_DOMAIN}/private/token`), false);
    assert.equal(
      isRinkoMediaUrl(`${CDN_DOMAIN}/wp-content/uploads/comics/flower-path/40/page.bin`),
      false,
    );
    assert.equal(
      isRinkoMediaUrl(`${CDN_DOMAIN}/wp-content/uploads/comics/series/1.webp?token=secret`),
      false,
    );
    for (const unsafe of [
      `${CDN_DOMAIN}/wp-content/uploads/comics/%252e%252e/private.webp`,
      `${CDN_DOMAIN}/wp-content/uploads/comics/%25252e%25252e/private.webp`,
      `${CDN_DOMAIN}/wp-content/uploads/comics/series/%25252f/private.webp`,
      `${CDN_DOMAIN}/wp-content/uploads/comics/series/%30%31.webp`,
      `${CDN_DOMAIN}/wp-content/uploads/comics/series/page\n.webp`,
      `${CDN_DOMAIN}/wp-content/uploads/comics/series/page\u2028.webp`,
      `${CDN_DOMAIN}/wp-content/uploads/comics/series/page.html%00.webp`,
      `${CDN_DOMAIN}/wp-content/uploads/comics/series/page%0A.webp`,
      `${CDN_DOMAIN}/wp-content/uploads/comics/series/page%E2%80%A8.webp`,
      `${CDN_DOMAIN}/wp-content/uploads/comics/series/page%E2%80%8B.webp`,
      `${CDN_DOMAIN}/wp-content/uploads/comics/series/page%EF%B7%90.webp`,
      `${CDN_DOMAIN}:443/wp-content/uploads/comics/series/01.webp`,
      `${CDN_DOMAIN}/wp-content/uploads/comics/series//01.webp`,
      `${CDN_DOMAIN}/wp-content/uploads/comics/series/01.svg`,
    ]) {
      assert.equal(isRinkoMediaUrl(unsafe), false, unsafe);
    }
    assert.equal(
      isRinkoMediaUrl(`${CDN_DOMAIN}/wp-content/uploads/comics/series/foo%20bar.webp`),
      true,
    );
    assert.equal(isRinkoCoverUrl(`${DOMAIN}:443/wp-content/uploads/2026/01/cover.webp`), false);
    assert.equal(isRinkoCoverUrl(`${DOMAIN}/wp-content/uploads/2026/01/cover%7F.webp`), false);
    assert.equal(isRinkoMediaUrl(`${DOMAIN}/wp-content/uploads/comics/series/1.webp`), false);
    assert.equal(isRinkoMediaUrl(`https://cdn.rinkocomics.com.evil.test/file.webp`), false);
    assert.equal(
      canonicalChapterSlug(`${DOMAIN}/chapter/flower-path-chapter-40/`),
      "flower-path-chapter-40",
    );
    assert.equal(isRinkoImageContentType("image/webp; charset=UTF-8"), true);
    for (const invalidContentType of [
      "image/webp;",
      "image/webp; charset",
      "image/webp; charset=",
      "image/webp;\0text/html",
      "image/webp\u2028;text/html",
    ]) {
      assert.equal(isRinkoImageContentType(invalidContentType), false, invalidContentType);
    }
  });

  it("keeps chapter and AJAX batch bounds internally consistent", () => {
    assert.equal(MAX_CHAPTERS, 2_000);
    assert.equal(MAX_CHAPTER_BATCHES, MAX_CHAPTERS / 10);
  });

  it("constructs only the frozen nonce-protected AJAX contract", () => {
    const request = buildChapterAjaxRequest(
      {
        ajaxUrl: AJAX_URL,
        nonce: "abc123DEF456",
        comicId: "13135",
        seriesSlug: "flower-path",
        nextOffset: 10,
        referer: `${DOMAIN}/comic/flower-path/`,
      },
      20,
    );
    assert.equal(request.url, AJAX_URL);
    assert.equal(request.method, "POST");
    assert.equal(request.headers?.origin, DOMAIN);
    assert.equal(request.headers?.referer, `${DOMAIN}/comic/flower-path/`);
    assert.equal(
      request.body,
      "action=load_more_chapters&nonce=abc123DEF456&comic_id=13135&offset=20",
    );
    assert.equal(request.cookies, undefined);
    assert.throws(
      () =>
        buildChapterAjaxRequest(
          {
            ajaxUrl: AJAX_URL,
            nonce: "abc123DEF456",
            comicId: "13135",
            seriesSlug: "other",
            nextOffset: 10,
            referer: `${DOMAIN}/comic/flower-path/`,
          },
          10,
        ),
      /context is invalid/i,
    );
    const hiddenContext = Object.defineProperty(
      {
        ajaxUrl: AJAX_URL,
        nonce: "abc123DEF456",
        comicId: "13135",
        seriesSlug: "flower-path",
        nextOffset: 10,
        referer: `${DOMAIN}/comic/flower-path/`,
      },
      "token",
      { value: "secret", enumerable: false },
    );
    assert.throws(() => buildChapterAjaxRequest(hiddenContext, 10), /context is invalid/i);
  });
});

describe("Rinko Comics response boundaries", () => {
  it("requires exact response URLs and declared content types", async () => {
    install({ body: "<html>ok</html>" });
    assert.equal(
      await fetchHtml({ url: `${DOMAIN}/comic/flower-path/`, method: "GET" }),
      "<html>ok</html>",
    );

    install({
      body: "<html>private</html>",
      responseUrl: `${DOMAIN}/login/`,
    });
    await assert.rejects(
      fetchHtml({ url: `${DOMAIN}/comic/flower-path/`, method: "GET" }),
      /response URL was not trusted/i,
    );

    install({ body: "{}", headers: { "content-type": "text/plain" } });
    await assert.rejects(
      fetchJsonResponse(buildRestCatalogRequest("", 1)),
      /invalid JSON content type/i,
    );

    for (const malformedContentType of [
      "text/html;",
      "text/html; charset",
      "text/html; charset=",
      "text/html;\0application/json",
      "text/html\u2028;application/json",
    ]) {
      install({ body: "<html>ok</html>", headers: { "content-type": malformedContentType } });
      await assert.rejects(
        fetchHtml({ url: `${DOMAIN}/comic/flower-path/`, method: "GET" }),
        /invalid response headers|invalid HTML content type/i,
      );
    }

    install({
      body: "<html>ok</html>",
      headers: {
        "content-type": "text/html",
        "Content-Type": "application/json",
      },
    });
    await assert.rejects(
      fetchHtml({ url: `${DOMAIN}/comic/flower-path/`, method: "GET" }),
      /invalid response headers/i,
    );

    install({
      body: "<html>ok</html>",
      headers: {
        "content-type": "text/html",
        "x-untrusted": 7 as unknown as string,
      },
    });
    await assert.rejects(
      fetchHtml({ url: `${DOMAIN}/comic/flower-path/`, method: "GET" }),
      /invalid response headers/i,
    );

    const inheritedHeaders = Object.create({ "bad header": "secret" }) as Record<string, string>;
    inheritedHeaders["content-type"] = "text/html";
    install({ body: "<html>ok</html>", headers: inheritedHeaders });
    await assert.rejects(
      fetchHtml({ url: `${DOMAIN}/comic/flower-path/`, method: "GET" }),
      /invalid response headers/i,
    );

    const hiddenHeader = Object.defineProperty({ "content-type": "text/html" }, "x-hidden", {
      value: 7,
      enumerable: false,
    }) as Record<string, string>;
    install({ body: "<html>ok</html>", headers: hiddenHeader });
    await assert.rejects(
      fetchHtml({ url: `${DOMAIN}/comic/flower-path/`, method: "GET" }),
      /invalid response headers/i,
    );

    const inheritedValue = Object.create({ "x-inherited": 7 }) as Record<string, string>;
    inheritedValue["content-type"] = "text/html";
    install({ body: "<html>ok</html>", headers: inheritedValue });
    await assert.rejects(
      fetchHtml({ url: `${DOMAIN}/comic/flower-path/`, method: "GET" }),
      /invalid response headers/i,
    );

    const inheritedSafe = Object.create({ "x-runtime-note": "safe" }) as Record<string, string>;
    inheritedSafe["content-type"] = "text/html";
    install({ body: "<html>ok</html>", headers: inheritedSafe });
    await assert.rejects(
      fetchHtml({ url: `${DOMAIN}/comic/flower-path/`, method: "GET" }),
      /invalid response headers/i,
    );

    const inheritedDuplicate = Object.create({ "Content-Type": "text/html" }) as Record<
      string,
      string
    >;
    inheritedDuplicate["content-type"] = "text/html";
    install({ body: "<html>ok</html>", headers: inheritedDuplicate });
    await assert.rejects(
      fetchHtml({ url: `${DOMAIN}/comic/flower-path/`, method: "GET" }),
      /invalid response headers/i,
    );

    install({
      body: "<html>ok</html>",
      headers: new Proxy<Record<string, string>>(
        {},
        {
          ownKeys() {
            throw new Error("secret-token");
          },
        },
      ),
    });
    await assert.rejects(
      fetchHtml({ url: `${DOMAIN}/comic/flower-path/`, method: "GET" }),
      (error: unknown) =>
        error instanceof Error &&
        error.message === "Rinko Comics returned invalid response headers." &&
        !("cause" in error),
    );
  });

  it("sheds runtime response capabilities and snapshots trusted fields exactly once", async () => {
    const request = buildRestCatalogRequest("", 1);
    let urlReads = 0;
    let statusReads = 0;
    let headerReads = 0;
    let cookieReads = 0;
    const response = { forged: "secret-token" } as unknown as Response;
    Object.defineProperties(response, {
      url: {
        enumerable: true,
        get() {
          urlReads += 1;
          if (urlReads > 1) throw new Error("secret-token");
          return request.url;
        },
      },
      status: {
        enumerable: true,
        get() {
          statusReads += 1;
          if (statusReads > 1) throw new Error("secret-token");
          return 200;
        },
      },
      headers: {
        enumerable: true,
        get() {
          headerReads += 1;
          if (headerReads > 1) throw new Error("secret-token");
          return {
            "content-type": "application/json",
            "x-wp-total": "0",
            "x-wp-totalpages": "0",
            "x-untrusted": "discarded",
          };
        },
      },
      cookies: {
        enumerable: true,
        get() {
          cookieReads += 1;
          return [{ name: "session", value: "secret-token" }];
        },
      },
    });
    Object.assign(globalThis, {
      Application: {
        arrayBufferToUTF8String: (data: ArrayBuffer) => new TextDecoder().decode(data),
        scheduleRequest: async (scheduledRequest: Request): Promise<[Response, ArrayBuffer]> => {
          scheduledRequest.url = "https://evil.example/token=secret";
          return [response, new TextEncoder().encode("[]").buffer];
        },
      },
    });
    const result = await fetchJsonResponse<unknown[]>(request);
    assert.deepEqual(result.value, []);
    assert.notEqual(result.response, response);
    assert.equal(urlReads, 1);
    assert.equal(statusReads, 1);
    assert.equal(headerReads, 1);
    assert.equal(cookieReads, 0);
    assert.deepEqual(result.response, {
      url: request.url,
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-wp-total": "0",
        "x-wp-totalpages": "0",
      },
      cookies: [],
    });
  });

  it("parses JSON without exposing hostile response fragments", async () => {
    install({ body: '{"ok":true}', headers: { "content-type": "application/json" } });
    assert.deepEqual(
      (await fetchJsonResponse<{ ok: boolean }>(buildRestCatalogRequest("secret", 1))).value,
      { ok: true },
    );

    for (const duplicate of [
      '{"success":false,"success":true,"data":{"html":""}}',
      '{"nonce":"evil","\\u006eonce":"trusted"}',
      '{"outer":{"key":1,"key":2}}',
    ]) {
      assert.throws(() => parseJsonDocument(duplicate), /invalid JSON/i);
    }
    install({
      body: '{"success":false,"success":true,"data":{"html":""}}',
      headers: { "content-type": "application/json" },
    });
    await assert.rejects(fetchJsonResponse(buildRestCatalogRequest("secret", 1)), /invalid JSON/i);

    install({ body: 'not json "secret-token"', headers: { "content-type": "application/json" } });
    await assert.rejects(
      fetchJsonResponse(buildRestCatalogRequest("secret", 1)),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, "Rinko Comics returned invalid JSON.");
        assert.doesNotMatch(error.message, /secret-token|search=secret|fragment/i);
        assert.equal(error.cause, undefined);
        return true;
      },
    );
  });

  it("rejects foreign requests and oversized bodies before decoding", async () => {
    const requests = install();
    await assert.rejects(
      fetchHtml({ url: "https://evil.example/private", method: "GET" }),
      /response URL was not trusted/i,
    );
    assert.equal(requests.length, 0);
    await assert.rejects(
      fetchHtml({ url: `${DOMAIN}/wp-login.php`, method: "GET" }),
      /response URL was not trusted/i,
    );
    assert.equal(requests.length, 0);
    const hiddenRequest = Object.defineProperty(
      { url: `${DOMAIN}/comic/flower-path/`, method: "GET" },
      "token",
      { value: "secret", enumerable: false },
    );
    await assert.rejects(fetchHtml(hiddenRequest), /could not be completed safely/i);
    const ajaxRequest = buildChapterAjaxRequest(
      {
        ajaxUrl: AJAX_URL,
        nonce: "abc123DEF456",
        comicId: "13135",
        seriesSlug: "flower-path",
        nextOffset: 10,
        referer: `${DOMAIN}/comic/flower-path/`,
      },
      10,
    );
    Object.defineProperty(ajaxRequest.headers!, "token", {
      value: "secret",
      enumerable: false,
    });
    await assert.rejects(fetchJsonResponse(ajaxRequest), /could not be completed safely/i);
    assert.equal(requests.length, 0);

    let decodes = 0;
    install({ data: new Uint8Array(2 * 1_024 * 1_024 + 1).buffer });
    Object.assign(globalThis.Application, {
      arrayBufferToUTF8String: () => {
        decodes += 1;
        return "";
      },
    });
    await assert.rejects(
      fetchHtml({ url: `${DOMAIN}/comic/flower-path/`, method: "GET" }),
      /too large/i,
    );
    assert.equal(decodes, 0);

    install({ data: Object.create(ArrayBuffer.prototype) as ArrayBuffer });
    await assert.rejects(
      fetchHtml({ url: `${DOMAIN}/comic/flower-path/`, method: "GET" }),
      /response body was invalid/i,
    );

    const detachedBody = new ArrayBuffer(0);
    structuredClone(detachedBody, { transfer: [detachedBody] });
    install({ data: detachedBody });
    await assert.rejects(
      fetchHtml({ url: `${DOMAIN}/comic/flower-path/`, method: "GET" }),
      /response body was invalid/i,
    );

    let resizableResponseReads = 0;
    const resizableBody = new ArrayBuffer(1, { maxByteLength: 2 * 1_024 * 1_024 + 1 });
    Object.assign(globalThis, {
      Application: {
        arrayBufferToUTF8String: () => "",
        scheduleRequest: async (request: Request): Promise<[Response, ArrayBuffer]> => [
          Object.defineProperties(
            {
              headers: { "content-type": "text/html" },
              cookies: [],
            },
            {
              url: {
                enumerable: true,
                get() {
                  resizableResponseReads += 1;
                  return request.url;
                },
              },
              status: {
                enumerable: true,
                get() {
                  resizableResponseReads += 1;
                  resizableBody.resize(2 * 1_024 * 1_024 + 1);
                  return 200;
                },
              },
            },
          ) as unknown as Response,
          resizableBody,
        ],
      },
    });
    await assert.rejects(
      fetchHtml({ url: `${DOMAIN}/comic/flower-path/`, method: "GET" }),
      /response body was invalid/i,
    );
    assert.equal(resizableResponseReads, 0);

    const decoderDetachedBody = new Uint8Array([60, 104, 116, 109, 108, 62]).buffer;
    install({ data: decoderDetachedBody });
    Object.assign(globalThis.Application, {
      arrayBufferToUTF8String: (data: ArrayBuffer) => {
        structuredClone(data, { transfer: [data] });
        return "<html>trusted</html>";
      },
    });
    await assert.rejects(
      fetchHtml({ url: `${DOMAIN}/comic/flower-path/`, method: "GET" }),
      /response body was invalid/i,
    );

    install({ body: "<html>ok</html>" });
    Object.assign(globalThis.Application, { arrayBufferToUTF8String: () => 7 });
    await assert.rejects(
      fetchHtml({ url: `${DOMAIN}/comic/flower-path/`, method: "GET" }),
      /could not be decoded safely/i,
    );
  });

  it("requires one exact dense scheduler response tuple", async () => {
    const request = { url: `${DOMAIN}/comic/flower-path/`, method: "GET" } as const;
    const response: Response = {
      url: request.url,
      status: 200,
      headers: { "content-type": "text/html" },
      cookies: [],
    };
    const data = new TextEncoder().encode("<html>ok</html>").buffer;
    const sparse: unknown[] = [];
    sparse.length = 2;
    Object.setPrototypeOf(sparse, { 0: response, 1: data });
    const accessor: unknown[] = [];
    accessor.length = 2;
    Object.defineProperties(accessor, {
      0: { get: () => response, enumerable: true, configurable: true },
      1: { value: data, enumerable: true, configurable: true },
    });
    const symbolTuple: unknown[] = [response, data];
    Object.defineProperty(symbolTuple, Symbol("token"), { value: "secret", enumerable: true });
    for (const scheduled of [[response, data, "extra"], sparse, accessor, symbolTuple]) {
      Object.assign(globalThis, {
        Application: {
          arrayBufferToUTF8String: (body: ArrayBuffer) => new TextDecoder().decode(body),
          scheduleRequest: async () => scheduled,
        },
      });
      await assert.rejects(fetchHtml(request), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, "Rinko Comics response was invalid.");
        assert.equal(error.cause, undefined);
        return true;
      });
    }
  });

  it("bounds concurrent scheduler work without retaining an unbounded queue", async () => {
    let started = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    Object.assign(globalThis, {
      Application: {
        arrayBufferToUTF8String: (body: ArrayBuffer) => new TextDecoder().decode(body),
        scheduleRequest: async (request: Request): Promise<[Response, ArrayBuffer]> => {
          started += 1;
          await gate;
          return [
            {
              url: request.url,
              status: 200,
              headers: { "content-type": "text/html" },
              cookies: [],
            },
            new TextEncoder().encode("<html>ok</html>").buffer,
          ];
        },
      },
    });
    const attempts = Array.from({ length: MAX_CONCURRENT_REQUESTS + 20 }, (_, index) =>
      fetchHtml({ url: `${DOMAIN}/comic/concurrency-${index}/`, method: "GET" }),
    );
    await Promise.resolve();
    assert.equal(started, MAX_CONCURRENT_REQUESTS);
    release?.();
    const outcomes = await Promise.allSettled(attempts);
    assert.equal(
      outcomes.filter((outcome) => outcome.status === "fulfilled").length,
      MAX_CONCURRENT_REQUESTS,
    );
    for (const outcome of outcomes) {
      if (outcome.status === "rejected") {
        assert.ok(outcome.reason instanceof Error);
        assert.equal(outcome.reason.message, "Rinko Comics request could not be completed safely.");
        assert.equal(outcome.reason.cause, undefined);
      }
    }
  });

  it("sanitizes scheduler failures without retaining causes or query secrets", async () => {
    Object.assign(globalThis, {
      Application: {
        arrayBufferToUTF8String: (data: ArrayBuffer) => new TextDecoder().decode(data),
        scheduleRequest: async () => {
          throw new Error("network failed for ?token=secret-response-fragment");
        },
      },
    });
    await assert.rejects(
      fetchHtml({ url: `${DOMAIN}/comic/flower-path/`, method: "GET" }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, "Rinko Comics request could not be completed safely.");
        assert.equal(error.cause, undefined);
        return true;
      },
    );
  });

  it("turns status failures into body-free public errors", async () => {
    install({ status: 403, body: "private token=value" });
    await assert.rejects(
      fetchHtml({ url: `${DOMAIN}/comic/flower-path/`, method: "GET" }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /denied this public request/i);
        assert.doesNotMatch(error.message, /token|value/);
        assert.equal(error.cause, undefined);
        return true;
      },
    );

    install({ status: Number.NaN, body: "private token=value" });
    await assert.rejects(
      fetchHtml({ url: `${DOMAIN}/comic/flower-path/`, method: "GET" }),
      /status -1/i,
    );

    let statusReads = 0;
    Object.assign(globalThis, {
      Application: {
        arrayBufferToUTF8String: () => "",
        scheduleRequest: async (request: Request): Promise<[Response, ArrayBuffer]> => [
          Object.defineProperty(
            {
              url: request.url,
              headers: { "content-type": "text/html" },
              cookies: [],
            },
            "status",
            {
              enumerable: true,
              get() {
                statusReads += 1;
                return 200;
              },
            },
          ) as unknown as Response,
          new Uint8Array(2 * 1_024 * 1_024 + 1).buffer,
        ],
      },
    });
    await assert.rejects(
      fetchHtml({ url: `${DOMAIN}/comic/flower-path/`, method: "GET" }),
      /too large/i,
    );
    assert.equal(statusReads, 0);
  });
});
