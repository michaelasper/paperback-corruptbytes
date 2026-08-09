import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, describe, it } from "node:test";

import type { Cookie, Request, Response as PaperbackResponse } from "@paperback/types";

import { MdxAuthManager, type MadaraCookieStore } from "./auth.js";
import { DOMAIN, buildCatalogUrl, buildMangaUrl } from "./network.js";
import {
  parseCatalogPage,
  parseChapterDetails,
  parseChapters,
  parseFilterOptions,
  parseMangaDetails,
} from "./parsers.js";

const live = process.env.MADARADEX_LIVE_TESTS === "1";
const originalApplication = globalThis.Application;
const userAgent = "Mozilla/5.0 PaperbackExtensionLiveContract/1.0";

const headersFrom = (headers: Headers): Record<string, string> =>
  Object.fromEntries(headers.entries());

const cookieFrom = (value: string): Cookie | undefined => {
  const parts = value.split(";").map((part) => part.trim());
  const [nameValue, ...attributes] = parts;
  const separator = nameValue?.indexOf("=") ?? -1;
  if (!nameValue || separator < 1) return undefined;
  const record = new Map(
    attributes.map((attribute) => {
      const index = attribute.indexOf("=");
      return index < 0
        ? [attribute.toLowerCase(), ""]
        : [attribute.slice(0, index).toLowerCase(), attribute.slice(index + 1)];
    }),
  );
  const expires = record.get("expires");
  return {
    name: nameValue.slice(0, separator),
    value: nameValue.slice(separator + 1),
    domain: record.get("domain") ?? "madaradex.org",
    path: record.get("path") ?? "/",
    ...(expires && !Number.isNaN(new Date(expires).getTime()) && { expires: new Date(expires) }),
  };
};

if (live) {
  Object.assign(globalThis, {
    Application: {
      arrayBufferToUTF8String: (buffer: ArrayBuffer) => new TextDecoder().decode(buffer),
      base64Decode: (value: string | ArrayBuffer): ArrayBuffer => {
        const encoded =
          typeof value === "string" ? value : new TextDecoder().decode(new Uint8Array(value));
        const bytes = Buffer.from(encoded, "base64");
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      },
      crypto_md5Hash: (value: string | ArrayBuffer): string =>
        createHash("md5")
          .update(typeof value === "string" ? value : Buffer.from(value))
          .digest("hex"),
      scheduleRequest: async (request: Request): Promise<[PaperbackResponse, ArrayBuffer]> => {
        const headers = new Headers(request.headers);
        headers.set("user-agent", userAgent);
        if (request.cookies && Object.keys(request.cookies).length > 0) {
          headers.set(
            "cookie",
            Object.entries(request.cookies)
              .map(([name, value]) => `${name}=${value}`)
              .join("; "),
          );
        }
        const response = await fetch(request.url, {
          method: request.method,
          headers,
          body: typeof request.body === "string" ? request.body : undefined,
          redirect: "follow",
          signal: AbortSignal.timeout(20_000),
        });
        const cookies = response.headers.getSetCookie().flatMap((value) => {
          const parsed = cookieFrom(value);
          return parsed ? [parsed] : [];
        });
        return [
          {
            url: response.url,
            status: response.status,
            headers: headersFrom(response.headers),
            cookies,
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

const requestText = async (url: string, cookie?: string): Promise<string> => {
  const requestHeaders = new Headers({
    "user-agent": userAgent,
    accept: "text/html,application/xhtml+xml,*/*;q=0.8",
  });
  if (cookie) requestHeaders.set("cookie", cookie);
  const response = await fetch(url, {
    headers: requestHeaders,
    redirect: "follow",
    signal: AbortSignal.timeout(20_000),
  });
  assert.equal(response.ok, true, `${response.status} from ${response.url}`);
  return response.text();
};

class MemoryStore implements MadaraCookieStore {
  cookies: Cookie[] = [];

  setCookie(cookie: Cookie): void {
    this.cookies = this.cookies.filter(
      (candidate) => candidate.name !== cookie.name || candidate.domain !== cookie.domain,
    );
    this.cookies.push(cookie);
  }

  deleteCookie(cookie: Cookie): void {
    this.cookies = this.cookies.filter(
      (candidate) => candidate.name !== cookie.name || candidate.domain !== cookie.domain,
    );
  }
}

describe("MadaraDex live public contract", { skip: !live }, () => {
  it("parses the live directory, all sorting pagination, and advanced taxonomy", async () => {
    const [directoryHtml, filtersHtml] = await Promise.all([
      requestText(buildCatalogUrl({ title: "" }, { id: "latest", label: "Latest" }, 1)),
      requestText(`${DOMAIN}/?s=magic&post_type=wp-manga`),
    ]);
    const directory = parseCatalogPage(directoryHtml);
    const filters = parseFilterOptions(filtersHtml);
    assert.ok(directory.items.length >= 15);
    assert.ok(directory.items.every((item) => /^\d+$/.test(item.mangaId)));
    assert.equal(directory.hasNextPage, true);
    assert.ok(filters.genres.length >= 20);
    assert.ok(filters.statuses.some((status) => status.id === "end"));
  });

  it("preserves an exported numeric series ID and exact fractional chapter IDs", async () => {
    const mangaId = "2872";
    const html = await requestText(buildMangaUrl(mangaId));
    const manga = parseMangaDetails(html, mangaId);
    const chapters = parseChapters(html, manga);
    assert.equal(manga.mangaId, mangaId);
    assert.equal(manga.mangaInfo.primaryTitle, "Savage Hero");
    assert.ok(chapters.length >= 100);
    assert.ok(chapters.some((chapter) => chapter.chapterId === "chapter-91-5"));
    assert.ok(chapters.every((chapter) => /^chapter-[\w.-]+$/.test(chapter.chapterId)));
  });

  it("obtains anonymous reader authorization and loads an authenticated CDN image", async () => {
    const store = new MemoryStore();
    const auth = new MdxAuthManager(store);
    await auth.ensureAuthenticated();
    const fingerprint = store.cookies.find((cookie) => cookie.name === "mdx_fp");
    const token = store.cookies.find((cookie) => cookie.name === "mdx_auth");
    assert.ok(fingerprint?.value);
    assert.ok(token?.value);

    const seriesHtml = await requestText(buildMangaUrl("2872"));
    const manga = parseMangaDetails(seriesHtml, "2872");
    const chapter = parseChapters(seriesHtml, manga).at(-1);
    assert.ok(chapter?.additionalInfo?.url);
    const authCookies = { mdx_fp: fingerprint.value, mdx_auth: token.value };
    const [readerResponse, readerBuffer] = await Application.scheduleRequest({
      url: chapter.additionalInfo.url,
      method: "GET",
      cookies: authCookies,
    });
    assert.equal(readerResponse.status, 200);
    const reader = await parseChapterDetails(
      Application.arrayBufferToUTF8String(readerBuffer),
      chapter,
    );
    assert.ok("pages" in reader && reader.pages.length > 0);
    if (!("pages" in reader)) assert.fail("Expected image pages");

    const response = await fetch(reader.pages[0]!, {
      headers: {
        "user-agent": userAgent,
        referer: `${DOMAIN}/`,
        cookie: `mdx_fp=${fingerprint.value}; mdx_auth=${token.value}`,
      },
      signal: AbortSignal.timeout(20_000),
    });
    assert.equal(response.ok, true, `${response.status} from authenticated CDN`);
    assert.match(response.headers.get("content-type") ?? "", /^image\//);
  });
});
