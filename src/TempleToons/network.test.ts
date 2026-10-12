import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { CloudflareError, type Request, type Response } from "@paperback/types";

import { TempleClient } from "./client.js";
import { fetchJson, fetchText } from "./network.js";
import { TEMPLE_SERIES_HTML } from "./test-fixtures.js";

const originalApplication = globalThis.Application;
const request = {
  url: "https://templetoons.com/comic/walk-in-the-night",
  method: "GET",
} satisfies Request;
const signature =
  "TempleToons uses Cloudflare Turnstile to protect against automated scraping. No personal data is collected.";
const wall = `<!DOCTYPE html><html><body><p>${signature}</p></body></html>`;
const routeWall =
  '<!DOCTYPE html><html><head><script src="/_next/static/chunks/app/challenge/page-3285c5ae76f36860.js" async=""></script></head><body>Loading...</body></html>';

const install = (body: string, url = request.url, status = 200): void => {
  Object.assign(globalThis, {
    Application: {
      arrayBufferToUTF8String: (data: ArrayBuffer) => new TextDecoder().decode(data),
      scheduleRequest: async (): Promise<[Response, ArrayBuffer]> => [
        { url, status, headers: { "content-type": "text/html" }, cookies: [] },
        new TextEncoder().encode(body).buffer,
      ],
    },
  });
};

afterEach(() => Object.assign(globalThis, { Application: originalApplication }));

const assertChallenge = (error: unknown): boolean => {
  assert.ok(error instanceof CloudflareError);
  assert.equal(
    error.message,
    "Temple requires Cloudflare Turnstile verification before this content can be accessed.",
  );
  assert.deepEqual(error.resolutionRequest, { url: "https://templetoons.com/", method: "GET" });
  return true;
};

describe("Temple response boundary", () => {
  for (const [name, body, url] of [
    [
      "trusted challenge route with its wall script",
      routeWall,
      "https://www.templetoons.com/challenge?redirect=secret",
    ],
    ["exact wall signature with the original response URL", wall, request.url],
  ] as const) {
    it(`rejects HTTP-200 ${name} for both text and JSON callers`, async () => {
      install(body, url);
      await assert.rejects(fetchText(request), assertChallenge);
      await assert.rejects(fetchJson(request), assertChallenge);
    });
  }

  it("passes ordinary pages, widgets, mentions, and bare challenge routes through unchanged", async () => {
    for (const [body, url] of [
      [TEMPLE_SERIES_HTML, request.url],
      [
        '<html><body><div class="cf-turnstile"></div><script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script></body></html>',
        request.url,
      ],
      ["<html><body>Cloudflare Turnstile is used on our contact form.</body></html>", request.url],
      ["<html><body>No chapters yet.</body></html>", "https://templetoons.com/challenge"],
      ["{}", "https://templetoons.com/challenge"],
      [signature, request.url],
      [routeWall, request.url],
    ] as const) {
      install(body, url);
      assert.equal(await fetchText(request), body);
    }
  });

  it("keeps the parser diagnostic for a genuinely empty chapter page", async () => {
    const client = new TempleClient();
    install(TEMPLE_SERIES_HTML);
    const manga = await client.getMangaDetails("walk-in-the-night");
    assert.equal(manga.mangaInfo.primaryTitle, "Walk In The Night [Complete Edition]");
    install("<html><body><h1>Walk In The Night</h1><p>No chapters yet.</p></body></html>");
    await assert.rejects(client.getChapters(manga), {
      message: "Temple returned no chapters from the series page.",
    });
  });

  it("preserves JSON results and body-free HTML or invalid JSON diagnostics", async () => {
    install('{"total":1,"projects":[]}');
    assert.deepEqual(await fetchJson(request), { total: 1, projects: [] });
    install(JSON.stringify({ message: signature }));
    assert.deepEqual(await fetchJson(request), { message: signature });
    install("<html><body>Ordinary page with Turnstile</body></html>");
    await assert.rejects(fetchJson(request), { message: "Temple returned HTML instead of JSON." });
    install("private-response-fragment");
    await assert.rejects(
      fetchJson({ ...request, url: `${request.url}?token=secret#secret` }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(
          error.message,
          "Temple returned invalid JSON for https://templetoons.com/comic/walk-in-the-night.",
        );
        assert.doesNotMatch(String(error.cause), /private-response-fragment|token|secret/);
        return true;
      },
    );
  });

  it("rejects unsafe URLs, oversized bodies, and failed HTTP statuses before classifying walls", async () => {
    for (const fetchBody of [fetchText, fetchJson]) {
      for (const url of [
        "https://evil.test/challenge",
        "http://templetoons.com/challenge",
        "https://user:secret@templetoons.com/challenge",
      ]) {
        install(wall, url);
        await assert.rejects(fetchBody(request), {
          message: "Temple response URL was not trusted.",
        });
      }
      install(wall);
      await assert.rejects(fetchBody({ url: "https://evil.test/challenge", method: "GET" }), {
        message: "Temple response URL was not trusted.",
      });
      install(wall + "x".repeat(8 * 1_024 * 1_024));
      await assert.rejects(fetchBody(request), {
        message: "Temple response was too large to process safely.",
      });
      install(wall, request.url, 500);
      await assert.rejects(fetchBody(request), {
        message: "Temple request failed with status 500.",
      });
    }
  });

  it("propagates the existing interceptor's Cloudflare diagnostic unchanged", async () => {
    const challenge = new CloudflareError(
      { url: "https://templetoons.com/", method: "GET" },
      "Existing challenge",
    );
    Object.assign(globalThis, {
      Application: {
        scheduleRequest: async () => {
          throw challenge;
        },
      },
    });
    await assert.rejects(fetchJson(request), (error: unknown) => error === challenge);
    await assert.rejects(fetchText(request), (error: unknown) => error === challenge);
  });

  it("does not cache a challenge and retries series metadata and chapters after access returns", async () => {
    const client = new TempleClient();
    install(wall);
    await assert.rejects(client.getMangaDetails("walk-in-the-night"), assertChallenge);
    install(TEMPLE_SERIES_HTML);
    const manga = await client.getMangaDetails("walk-in-the-night");
    assert.equal(manga.mangaInfo.primaryTitle, "Walk In The Night [Complete Edition]");
    install(wall);
    await assert.rejects(client.getChapters(manga), assertChallenge);
    install(TEMPLE_SERIES_HTML);
    const chapters = await client.getChapters(manga);
    assert.deepEqual(
      chapters.map((chapter) => chapter.chapNum),
      [66, 65, 64],
    );
    install(wall);
    assert.equal(
      (await client.getMangaDetails("walk-in-the-night")).mangaInfo.primaryTitle,
      "Walk In The Night [Complete Edition]",
    );
    assert.deepEqual(
      (await client.getChapters(manga)).map((chapter) => chapter.chapNum),
      [66, 65, 64],
    );
  });
});
