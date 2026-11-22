import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PenguinClient, type PenguinTransport } from "./client.js";
import { PenguinAccessError } from "./models.js";
import { decodeChapterId, encodeChapterId, encodeSeriesId } from "./network.js";
import {
  PENGUIN_SERIES_SLUG,
  catalogHtml,
  chapterHtml,
  fixtureChapters,
  searchHtml,
  seriesHtml,
} from "./test-fixtures.js";

const DOMAIN = "https://penguin-squad.com";
const seriesUrl = `${DOMAIN}/novels/${PENGUIN_SERIES_SLUG}`;
const seriesId = encodeSeriesId(PENGUIN_SERIES_SLUG);
const chapterSlug = "chapter-3-synthetic-part-3";
const chapterUrl = `${seriesUrl}/${chapterSlug}`;

interface Recorder {
  readonly transport: PenguinTransport;
  readonly calls: string[];
}

const recorder = (routes: Record<string, string | (() => string)>): Recorder => {
  const calls: string[] = [];
  return {
    calls,
    transport: async (url: string) => {
      calls.push(url);
      const route = routes[url];
      if (route === undefined) throw new Error(`Unexpected fixture request: ${url}`);
      return typeof route === "function" ? route() : route;
    },
  };
};

const defaultRoutes = (): Record<string, string | (() => string)> => ({
  [`${DOMAIN}/novels`]: catalogHtml({ count: 60 }),
  [`${DOMAIN}/novels?page=2`]: catalogHtml({ page: 2, count: 60 }),
  [`${DOMAIN}/novels?page=5`]: catalogHtml({ page: 5, count: 5 }),
  [`${DOMAIN}/novels?page=6`]: catalogHtml({ page: 6, count: 0, emptyState: true }),
  [`${DOMAIN}/search?q=dragon`]: searchHtml({ term: "dragon", count: 5 }),
  [seriesUrl]: seriesHtml(),
  [chapterUrl]: chapterHtml(),
});

describe("Penguin Squad client catalog", () => {
  it("serves one page at a time and reuses a cached page", async () => {
    const { transport, calls } = recorder(defaultRoutes());
    const client = new PenguinClient(transport);
    const first = await client.getCatalogPage(1);
    assert.equal(first.items.length, 60);
    assert.equal(first.next, 2);
    await client.getCatalogPage(1);
    assert.equal(calls.length, 1);
    const second = await client.getCatalogPage(2);
    assert.equal(second.items[0]?.title, "Synthetic Series 200");
    assert.equal(calls.length, 2);
  });

  it("stops before an unproven page and accepts a recognised empty page", async () => {
    const { transport } = recorder(defaultRoutes());
    const client = new PenguinClient(transport);
    const terminal = await client.getCatalogPage(5);
    assert.equal(terminal.items.length, 5);
    assert.equal(terminal.next, undefined);
    const empty = await client.getCatalogPage(6);
    assert.deepEqual(empty.items, []);
  });

  it("caches searches per normalised term", async () => {
    const { transport, calls } = recorder(defaultRoutes());
    const client = new PenguinClient(transport);
    const results = await client.search("  dragon  ");
    assert.equal(results.items.length, 5);
    await client.search("dragon");
    assert.equal(calls.length, 1);
  });

  it("rejects an unsupported page number before any request", async () => {
    const { transport, calls } = recorder(defaultRoutes());
    const client = new PenguinClient(transport);
    await assert.rejects(client.getCatalogPage(0), /page number is invalid/);
    assert.equal(calls.length, 0);
  });
});

describe("Penguin Squad client series and reader", () => {
  it("shares one series fetch between details and chapters", async () => {
    const { transport, calls } = recorder(defaultRoutes());
    const client = new PenguinClient(transport);
    const first = await client.getSeries(seriesId);
    const second = await client.getSeries(seriesId);
    assert.equal(first.chapters.length, 4);
    assert.equal(second.title, "Synthetic Novel");
    assert.deepEqual(calls, [seriesUrl]);
  });

  it("reads a public chapter and never caches its content", async () => {
    const { transport, calls } = recorder(defaultRoutes());
    const client = new PenguinClient(transport);
    const ref = { seriesId, chapterId: encodeChapterId(PENGUIN_SERIES_SLUG, chapterSlug) };
    const reader = await client.read(ref);
    assert.match(reader.html, /Synthetic paragraph 1\./);
    await client.read(ref);
    assert.equal(calls.filter((url) => url === chapterUrl).length, 2);
  });

  it("refuses a chapter the records mark as premium", async () => {
    const { transport, calls } = recorder(defaultRoutes());
    const client = new PenguinClient(transport);
    const locked = {
      seriesId,
      chapterId: encodeChapterId(PENGUIN_SERIES_SLUG, "chapter-4-synthetic-part-4"),
    };
    await assert.rejects(
      client.read(locked),
      (error: unknown) => error instanceof PenguinAccessError && error.reason === "locked",
    );
    assert.equal(
      calls.some((url) => url.includes("chapter-4")),
      false,
    );
  });

  it("re-reads the records so a stale public listing cannot authorise a read", async () => {
    const chapters = fixtureChapters();
    let served = 0;
    const routes = defaultRoutes();
    routes[seriesUrl] = () => {
      served += 1;
      return served === 1
        ? seriesHtml({ chapters })
        : seriesHtml({
            chapters: chapters.map((chapter) =>
              chapter.slug === chapterSlug ? { ...chapter, premium: true } : chapter,
            ),
          });
    };
    const { transport, calls } = recorder(routes);
    const client = new PenguinClient(transport);
    const ref = { seriesId, chapterId: encodeChapterId(PENGUIN_SERIES_SLUG, chapterSlug) };
    assert.equal((await client.getSeries(seriesId)).chapters[1]?.access.kind, "public");
    await assert.rejects(
      client.read(ref),
      (error: unknown) => error instanceof PenguinAccessError && error.reason === "locked",
    );
    assert.equal(calls.filter((url) => url === seriesUrl).length, 2);
    assert.equal(calls.includes(chapterUrl), false);
  });

  it("refuses records whose access cannot be proven", async () => {
    const chapters = fixtureChapters().map((chapter) =>
      chapter.slug === chapterSlug ? { ...chapter, premium: undefined } : chapter,
    );
    const routes = defaultRoutes();
    routes[seriesUrl] = seriesHtml({ chapters, includeCounts: false });
    const { transport } = recorder(routes);
    const client = new PenguinClient(transport);
    const ref = { seriesId, chapterId: encodeChapterId(PENGUIN_SERIES_SLUG, chapterSlug) };
    const series = await client.getSeries(seriesId);
    assert.equal(
      series.chapters.find((one) => one.chapterId === ref.chapterId)?.access.kind,
      "unknown",
    );
    await assert.rejects(
      client.read(ref),
      (error: unknown) => error instanceof PenguinAccessError && error.reason === "unknown",
    );
  });

  it("rejects a chapter that is not in the requested series", async () => {
    const { transport } = recorder(defaultRoutes());
    const client = new PenguinClient(transport);
    await assert.rejects(
      client.read({
        seriesId,
        chapterId: encodeChapterId(PENGUIN_SERIES_SLUG, "chapter-9-not-published"),
      }),
      /does not belong to this series/,
    );
    await assert.rejects(
      client.read({
        seriesId,
        chapterId: encodeChapterId("other-novel", chapterSlug),
      }),
      /does not belong to this series/,
    );
    assert.equal(
      decodeChapterId(encodeChapterId("other-novel", chapterSlug)).seriesId,
      encodeSeriesId("other-novel"),
    );
  });

  it("resolves pasted series and chapter URLs to their series", async () => {
    const { transport } = recorder(defaultRoutes());
    const client = new PenguinClient(transport);
    assert.equal((await client.resolvePastedUrl(`${seriesUrl}`))?.title, "Synthetic Novel");
    assert.equal((await client.resolvePastedUrl(chapterUrl))?.title, "Synthetic Novel");
    assert.equal(await client.resolvePastedUrl("dragon knight"), undefined);
  });

  it("drops cached series and catalog records when caches are invalidated", async () => {
    const routes = defaultRoutes();
    const { transport, calls } = recorder(routes);
    const client = new PenguinClient(transport);
    await client.getSeries(seriesId);
    await client.getCatalogPage(1);
    client.invalidateCaches();
    await client.getSeries(seriesId);
    await client.getCatalogPage(1);
    assert.equal(calls.length, 4);
  });
});
