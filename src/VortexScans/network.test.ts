import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import type { Request, Response } from "@paperback/types";

import {
  buildApiUrl,
  buildSearchUrl,
  fetchJSON,
  parseSeriesUrl,
  type SearchMetadata,
} from "./network.js";

type ApplicationMock = {
  arrayBufferToUTF8String(buffer: ArrayBuffer): string;
  scheduleRequest(request: Request): Promise<[Response, ArrayBuffer]>;
};

const originalApplication = globalThis.Application;

const encode = (value: string): ArrayBuffer => new TextEncoder().encode(value).buffer;

const installApplication = (
  status: number,
  body: string,
  headers: Record<string, string> = {},
): Request[] => {
  const requests: Request[] = [];
  const mock: ApplicationMock = {
    arrayBufferToUTF8String: (buffer) => new TextDecoder().decode(buffer),
    scheduleRequest: async (request) => {
      requests.push(request);
      return [
        {
          url: request.url,
          status,
          headers,
          cookies: [],
        } as Response,
        encode(body),
      ];
    },
  };

  Object.assign(globalThis, { Application: mock });
  return requests;
};

afterEach(() => {
  Object.assign(globalThis, { Application: originalApplication });
});

describe("Vortex network helpers", () => {
  it("builds deterministic API URLs and omits undefined parameters", () => {
    assert.equal(
      buildApiUrl("query", {
        page: 2,
        perPage: 18,
        searchTerm: "Sword & Sorcery",
        ignored: undefined,
      }),
      "https://api.vortexscans.org/api/query?page=2&perPage=18&searchTerm=Sword%20%26%20Sorcery",
    );
  });

  it("builds a complete advanced-search request", () => {
    const metadata: SearchMetadata = {
      status: ["ONGOING"],
      type: ["MANHWA"],
      direction: ["asc"],
      genres: { "1": "included", "6": "included", "12": "excluded" },
    };

    assert.equal(
      buildSearchUrl(
        { title: "  Martial   Hero  ", metadata },
        { id: "totalViews", label: "Views" },
        3,
      ),
      "https://api.vortexscans.org/api/query?page=3&perPage=18&searchTerm=Martial%20Hero&orderBy=totalViews&orderDirection=asc&seriesStatus=ONGOING&seriesType=MANHWA&genreIds=1%2C6&excludedGenreIds=12",
    );
  });

  it("accepts only Vortex series URLs and decodes the slug", () => {
    assert.equal(
      parseSeriesUrl("https://www.vortexscans.org/series/a-witch%27s-life/?ref=reader"),
      "a-witch's-life",
    );
    assert.equal(parseSeriesUrl("https://vortexscans.org/series/"), undefined);
    assert.equal(parseSeriesUrl("https://evil.example/series/a-witch"), undefined);
  });
});

describe("fetchJSON", () => {
  it("returns JSON for successful 2xx responses", async () => {
    const requests = installApplication(201, '{"ok":true}');

    assert.deepEqual(
      await fetchJSON<{ ok: boolean }>({ url: "https://example.test/resource", method: "POST" }),
      { ok: true },
    );
    assert.equal(requests.length, 1);
  });

  it("surfaces authentication, rate-limit, not-found, and generic HTTP failures", async () => {
    installApplication(401, '{"message":"Unauthorized"}');
    await assert.rejects(
      fetchJSON({ url: "https://example.test/private", method: "GET" }),
      /log in.*Vortex/i,
    );

    installApplication(429, "slow down");
    await assert.rejects(
      fetchJSON({ url: "https://example.test/limited", method: "GET" }),
      /rate limit/i,
    );

    installApplication(404, "missing");
    await assert.rejects(
      fetchJSON({ url: "https://example.test/missing", method: "GET" }),
      /not found/i,
    );

    installApplication(500, '{"message":"Database unavailable"}');
    await assert.rejects(
      fetchJSON({ url: "https://example.test/error", method: "GET" }),
      /500.*Database unavailable/i,
    );
  });

  it("reports malformed JSON without leaking a large response body", async () => {
    installApplication(200, `<html>${"x".repeat(2_000)}</html>`);

    await assert.rejects(
      fetchJSON({ url: "https://example.test/not-json", method: "GET" }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /parse JSON/i);
        assert.ok(error.message.length < 500);
        return true;
      },
    );
  });
});
