import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";

import type {
  Chapter,
  ChapterDetails,
  Request as PaperbackRequest,
  Response as PaperbackResponse,
  SourceManga,
} from "@paperback/types";

import { AtsumaruClient } from "../src/Atsumaru/client.js";
import { DIVA_SCANS_SITE } from "../src/DivaScans/site.js";
import { MadaraDexClient } from "../src/MadaraDex/client.js";
import { MgekoClient } from "../src/Mgeko/client.js";
import { NovelDashClient } from "../src/shared/noveldash-client.js";
import type { NovelDashSite } from "../src/shared/noveldash-models.js";
import { ThunderClient } from "../src/Thunderscans/client.js";
import { VALIR_SCANS_SITE } from "../src/ValirScans/site.js";
import {
  fetchChapterContent as fetchVortexChapterContent,
  fetchChapterList as fetchVortexChapterList,
  fetchPostDetails as fetchVortexPostDetails,
  fetchSearchPage as fetchVortexSearchPage,
} from "../src/VortexScans/client.js";
import {
  parseChapterDetails as parseVortexChapterDetails,
  parseChapterList as parseVortexChapterList,
  parseMangaDetails as parseVortexMangaDetails,
  parseMangaList as parseVortexMangaList,
} from "../src/VortexScans/parsers.js";
import {
  createDeterministicRandom,
  deriveDeterministicSeed,
  type DeterministicRandom,
  runBoundedTasks,
} from "./random-runtime.js";

const USER_AGENT = "Mozilla/5.0 PaperbackExtensionRandomLive/1.0";
const REQUEST_TIMEOUT_MS = 30_000;
const RETRYABLE_HTTP_STATUSES = new Set([429, 502, 503, 504]);
const DEFAULT_SAMPLES_PER_SOURCE = 3;
const MAX_SAMPLES_PER_SOURCE = 8;
const DEFAULT_SOURCE_CONCURRENCY = 3;
const MAX_SOURCE_CONCURRENCY = 7;

interface ProbeStats {
  catalogItems: number;
  chapters: number;
  readers: number;
  series: number;
  unavailable: number;
}

interface CatalogItem {
  mangaId: string;
  title: string;
}

const output = (message: string): void => {
  process.stdout.write(`${message}\n`);
};

const integerSetting = (name: string, fallback: number, maximum: number): number => {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}.`);
  }
  return parsed;
};

const seedSetting = (): number => {
  const raw = process.env.LIVE_RANDOM_SEED;
  if (raw === undefined) return randomBytes(4).readUInt32LE(0);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 0xffff_ffff) {
    throw new Error("LIVE_RANDOM_SEED must be an unsigned 32-bit integer.");
  }
  return parsed >>> 0;
};

const seed = seedSetting();
const samplesPerSource = integerSetting(
  "LIVE_RANDOM_SAMPLES",
  DEFAULT_SAMPLES_PER_SOURCE,
  MAX_SAMPLES_PER_SOURCE,
);
const sourceConcurrency = integerSetting(
  "LIVE_RANDOM_CONCURRENCY",
  DEFAULT_SOURCE_CONCURRENCY,
  MAX_SOURCE_CONCURRENCY,
);

const isCatalogTombstone = (error: unknown): boolean => {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    if (/(?:content (?:was )?not found|(?:http|status) 404)/i.test(current.message)) return true;
    current = current.cause;
  }
  return false;
};

const headersFrom = (headers: Headers): Record<string, string> =>
  Object.fromEntries(headers.entries());

const fetchWithTransientRetry = async (
  request: PaperbackRequest,
  headers: Headers,
): Promise<globalThis.Response> => {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(request.url, {
        method: request.method ?? "GET",
        headers,
        body: typeof request.body === "string" ? request.body : undefined,
        redirect: "follow",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (attempt === 0 && RETRYABLE_HTTP_STATUSES.has(response.status)) {
        await response.body?.cancel();
        await new Promise((resolve) => setTimeout(resolve, 500));
        continue;
      }
      return response;
    } catch (error: unknown) {
      lastError = error;
      if (attempt > 0 || !(error instanceof DOMException) || error.name !== "TimeoutError")
        throw error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw lastError;
};

const originalApplication = globalThis.Application;

Object.assign(globalThis, {
  Application: {
    arrayBufferToUTF8String: (buffer: ArrayBuffer): string => new TextDecoder().decode(buffer),
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
    scheduleRequest: async (
      request: PaperbackRequest,
    ): Promise<[PaperbackResponse, ArrayBuffer]> => {
      const headers = new Headers(request.headers);
      headers.set("user-agent", USER_AGENT);
      if (request.cookies && Object.keys(request.cookies).length > 0) {
        headers.set(
          "cookie",
          Object.entries(request.cookies)
            .map(([name, value]) => `${name}=${value}`)
            .join("; "),
        );
      }
      const response = await fetchWithTransientRetry(request, headers);
      return [
        {
          url: response.url,
          status: response.status,
          headers: headersFrom(response.headers),
          cookies: [],
        },
        await response.arrayBuffer(),
      ];
    },
  },
});

const validateManga = (manga: SourceManga): void => {
  assert.ok(manga.mangaId.length > 0, "Manga ID was empty.");
  assert.ok(manga.mangaInfo.primaryTitle.trim().length > 0, `${manga.mangaId} had no title.`);
  assert.match(
    manga.mangaInfo.thumbnailUrl,
    /^https:\/\//,
    `${manga.mangaId} returned a non-HTTPS cover.`,
  );
};

const validateChapters = (manga: SourceManga, chapters: Chapter[]): void => {
  const keys = chapters.map((chapter) => `${chapter.chapterId}\0${chapter.version ?? ""}`);
  assert.equal(
    new Set(keys).size,
    keys.length,
    `${manga.mangaId} returned duplicate chapter identities.`,
  );
  chapters.forEach((chapter, index) => {
    assert.ok(chapter.chapterId.length > 0, `${manga.mangaId} returned an empty chapter ID.`);
    assert.ok(Number.isFinite(chapter.chapNum), `${chapter.chapterId} had an invalid number.`);
    assert.equal(chapter.sortingIndex, index, `${chapter.chapterId} had an unstable sort index.`);
    if (chapter.publishDate) {
      assert.ok(
        Number.isFinite(chapter.publishDate.getTime()),
        `${chapter.chapterId} had an invalid date.`,
      );
    }
  });
};

const validateReader = (chapter: Chapter, details: ChapterDetails): void => {
  if ("pages" in details) {
    assert.ok(details.pages.length > 0, `${chapter.chapterId} returned no image pages.`);
    assert.ok(
      details.pages.every((url) => url.startsWith("https://")),
      `${chapter.chapterId} returned a non-HTTPS image page.`,
    );
    return;
  }
  if (details.type === "html") {
    assert.ok(details.html.length > 100, `${chapter.chapterId} returned empty novel HTML.`);
    assert.doesNotMatch(details.html, /<(?:script|iframe|form)\b/i);
    return;
  }
  assert.fail(`${chapter.chapterId} returned an unsupported file reader.`);
};

const probeSeries = async (
  random: DeterministicRandom,
  source: string,
  items: readonly CatalogItem[],
  load: (mangaId: string) => Promise<{ chapters: Chapter[]; manga: SourceManga }>,
  read: (chapter: Chapter) => Promise<ChapterDetails>,
  readable: (chapter: Chapter) => boolean = () => true,
): Promise<ProbeStats> => {
  assert.ok(items.length > 0, `${source} returned an empty randomized catalog sample.`);
  const selected = random.sampleUnique(items, items.length, (item) => item.mangaId);
  assert.ok(selected.length > 0, `${source} did not expose a unique title to probe.`);
  const target = Math.min(samplesPerSource, selected.length);
  const stats: ProbeStats = {
    catalogItems: items.length,
    chapters: 0,
    readers: 0,
    series: 0,
    unavailable: 0,
  };

  for (const item of selected) {
    if (stats.series >= target) break;
    let loaded: { chapters: Chapter[]; manga: SourceManga };
    try {
      loaded = await load(item.mangaId);
    } catch (error: unknown) {
      if (isCatalogTombstone(error)) {
        stats.unavailable += 1;
        continue;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${item.title} (${item.mangaId}) failed to load: ${message}`, {
        cause: error,
      });
    }
    const { manga, chapters } = loaded;
    validateManga(manga);
    validateChapters(manga, chapters);
    stats.series += 1;
    stats.chapters += chapters.length;

    const candidates = chapters.filter(readable);
    if (candidates.length === 0) continue;
    const chapter = random.pick(candidates);
    try {
      validateReader(chapter, await read(chapter));
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `${item.title} (${item.mangaId}) chapter ${chapter.chapNum} failed: ${message}`,
        { cause: error },
      );
    }
    stats.readers += 1;
  }
  assert.equal(
    stats.series,
    target,
    `${source} exposed too many stale catalog entries to complete the randomized sample.`,
  );
  return stats;
};

const searchTerms = ["", "a", "dragon", "love", "mage", "return", "sword"] as const;

const probeAtsumaru = async (random: DeterministicRandom): Promise<ProbeStats> => {
  const client = new AtsumaruClient();
  const sorts = [
    "relevance",
    "title",
    "most-viewed",
    "trending",
    "recently-added",
    "released",
    "topRated",
  ] as const;
  const pages = await Promise.all(
    [0, 1].map((index) =>
      client.getSearchPage(
        {
          title: index === 0 ? "" : random.pick(searchTerms),
          metadata: { adult: "safe" },
        },
        { id: random.pick(sorts), label: "Random probe" },
        index === 0 ? random.integer(1, 8) : random.integer(1, 3),
      ),
    ),
  );
  const items = pages.flatMap((page) => page.items);
  return probeSeries(
    random,
    "Atsumaru",
    items,
    async (mangaId) => {
      const manga = await client.getMangaDetails(mangaId);
      return { manga, chapters: await client.getChapters(manga) };
    },
    (chapter) => client.getChapterDetails(chapter),
  );
};

const probeMadaraDex = async (random: DeterministicRandom): Promise<ProbeStats> => {
  const client = new MadaraDexClient();
  const sorts = ["latest", "alphabet", "rating", "trending", "views", "new-manga"] as const;
  const optionalPage = async (
    query: Parameters<MadaraDexClient["getCatalogPage"]>[0],
    sorting: Parameters<MadaraDexClient["getCatalogPage"]>[1],
    page: number,
  ) => {
    try {
      return await client.getCatalogPage(query, sorting, page);
    } catch (error: unknown) {
      if (isCatalogTombstone(error)) return { items: [], hasNextPage: false };
      throw error;
    }
  };
  const pages = await Promise.all([
    optionalPage(
      { title: "" },
      { id: random.pick(sorts), label: "Random probe" },
      random.integer(1, 5),
    ),
    optionalPage(
      { title: random.pick(searchTerms) },
      { id: random.pick(sorts), label: "Random probe" },
      random.integer(1, 2),
    ),
  ]);
  const items = pages.flatMap((page) => page.items);
  return probeSeries(
    random,
    "MadaraDex",
    items,
    async (mangaId) => {
      const manga = await client.getMangaDetails(mangaId);
      return { manga, chapters: await client.getChapters(manga) };
    },
    (chapter) => client.getChapterDetails(chapter),
  );
};

const probeMgeko = async (random: DeterministicRandom): Promise<ProbeStats> => {
  const client = new MgekoClient();
  const sorts = [
    "latest",
    "recently_added",
    "popular_daily",
    "popular_weekly",
    "popular_monthly",
    "popular_all_time",
    "rating",
    "az",
    "za",
  ] as const;
  const pages = await Promise.all([
    client.getBrowsePage(
      { title: "" },
      { id: random.pick(sorts), label: "Random probe" },
      random.integer(1, 8),
      true,
    ),
    client.getBrowsePage(
      { title: random.pick(searchTerms) },
      { id: random.pick(sorts), label: "Random probe" },
      random.integer(1, 3),
      true,
    ),
  ]);
  const items = pages.flatMap((page) => page.items);
  return probeSeries(
    random,
    "Mgeko",
    items,
    async (mangaId) => {
      const manga = await client.getMangaDetails(mangaId);
      return { manga, chapters: await client.getChapters(manga) };
    },
    (chapter) => client.getChapterDetails(chapter),
  );
};

const probeThunder = async (random: DeterministicRandom): Promise<ProbeStats> => {
  const client = new ThunderClient();
  const sorts = ["update", "latest", "popular", "title", "titlereverse"] as const;
  const pages = await Promise.all([
    client.getDirectoryPage(
      { title: "" },
      { id: random.pick(sorts), label: "Random probe" },
      random.integer(1, 5),
    ),
    client.getDirectoryPage({ title: random.pick(searchTerms) }, undefined, random.integer(1, 2)),
  ]);
  const items = pages.flatMap((page) => page.items);
  return probeSeries(
    random,
    "Thunder",
    items,
    async (mangaId) => {
      const manga = await client.getMangaDetails(mangaId);
      return { manga, chapters: await client.getChapters(manga, true) };
    },
    (chapter) => client.getChapterDetails(chapter),
    (chapter) => Boolean(chapter.additionalInfo?.url),
  );
};

const probeVortex = async (random: DeterministicRandom): Promise<ProbeStats> => {
  const sorts = [
    "lastChapterAddedAt",
    "totalViews",
    "createdAt",
    "chaptersCount",
    "postTitle",
  ] as const;
  const pages = await Promise.all([
    fetchVortexSearchPage(
      { title: "", metadata: { direction: ["desc"] } },
      { id: random.pick(sorts), label: "Random probe" },
      random.integer(1, 5),
    ),
    fetchVortexSearchPage(
      { title: random.pick(searchTerms), metadata: { direction: ["desc"] } },
      { id: random.pick(sorts), label: "Random probe" },
      random.integer(1, 2),
    ),
  ]);
  const items = pages.flatMap(parseVortexMangaList);
  return probeSeries(
    random,
    "Vortex",
    items,
    async (mangaId) => {
      const response = await fetchVortexPostDetails(mangaId);
      const manga = parseVortexMangaDetails(response.post ?? response, mangaId);
      const chapters = parseVortexChapterList(await fetchVortexChapterList(manga), manga, {
        showLocked: true,
      });
      return { manga, chapters };
    },
    async (chapter) => parseVortexChapterDetails(await fetchVortexChapterContent(chapter), chapter),
    (chapter) => chapter.additionalInfo?.isAccessible === "true",
  );
};

const probeNovelDash = async (
  site: NovelDashSite,
  random: DeterministicRandom,
): Promise<ProbeStats> => {
  const client = new NovelDashClient(site);
  const sorts = ["updated", "trending", "popular", "views", "rating", "longest", "newest"];
  // These white-label sites share relatively expensive database-backed sort routes. Keep their
  // randomized catalog probes sequential so the test does not create its own timeout condition.
  const pages = [
    await client.getCatalogPage(
      { title: "" },
      { id: random.pick(sorts), label: "Random probe" },
      random.integer(1, 8),
    ),
    await client.getCatalogPage(
      { title: random.pick(searchTerms) },
      { id: random.pick(sorts), label: "Random probe" },
      random.integer(1, 2),
    ),
  ];
  const items = pages.flatMap((page) => page.items);
  return probeSeries(
    random,
    site.name,
    items,
    async (mangaId) => {
      const manga = await client.getMangaDetails(mangaId);
      return {
        manga,
        chapters: await client.getChapters(manga, { showLocked: true }),
      };
    },
    (chapter) => client.getChapterDetails(chapter),
    (chapter) => chapter.additionalInfo?.isAccessible === "true",
  );
};

const probes = [
  ["Atsumaru", probeAtsumaru],
  ["Diva Scans", (random: DeterministicRandom) => probeNovelDash(DIVA_SCANS_SITE, random)],
  ["MadaraDex", probeMadaraDex],
  ["Mgeko", probeMgeko],
  ["Thunder", probeThunder],
  ["Valir Scans", (random: DeterministicRandom) => probeNovelDash(VALIR_SCANS_SITE, random)],
  ["Vortex", probeVortex],
] as const;

const failures: Error[] = [];
output(`Random live seed: ${seed} (0x${seed.toString(16).padStart(8, "0")})`);
output(`Samples per source: ${samplesPerSource}`);
output(`Source concurrency: ${sourceConcurrency}`);

const allStarted = performance.now();
try {
  const results = await runBoundedTasks(
    probes.map(([name, probe]) => async () => {
      const started = performance.now();
      const random = createDeterministicRandom(deriveDeterministicSeed(seed, name));
      const stats = await probe(random);
      return { elapsedMs: Math.round(performance.now() - started), stats };
    }),
    sourceConcurrency,
  );
  for (const [index, result] of results.entries()) {
    const [name] = probes[index]!;
    if (result.status === "fulfilled") {
      const { elapsedMs, stats } = result.value;
      output(
        `${name}: ${stats.series} series, ${stats.chapters} chapters, ${stats.readers} readers ` +
          `from ${stats.catalogItems} catalog items` +
          (stats.unavailable > 0 ? `, ${stats.unavailable} stale skipped` : "") +
          ` (${elapsedMs}ms)`,
      );
    } else {
      const failure =
        result.reason instanceof Error ? result.reason : new Error(String(result.reason));
      failures.push(new Error(`${name}: ${failure.message}`, { cause: failure }));
      output(`${name}: FAIL — ${failure.message}`);
    }
  }
} finally {
  Object.assign(globalThis, { Application: originalApplication });
}

if (failures.length > 0) {
  throw new AggregateError(failures, `${failures.length} randomized source probe(s) failed.`);
}

output(`All randomized live probes passed in ${Math.round(performance.now() - allStarted)}ms.`);
