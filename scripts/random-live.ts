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
import { MadaraDexClient } from "../src/MadaraDex/client.js";
import { MgekoClient } from "../src/Mgeko/client.js";
import { ThunderClient } from "../src/Thunderscans/client.js";
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

const USER_AGENT = "Mozilla/5.0 PaperbackExtensionRandomLive/1.0";
const REQUEST_TIMEOUT_MS = 25_000;
const DEFAULT_SAMPLES_PER_SOURCE = 3;
const MAX_SAMPLES_PER_SOURCE = 8;

interface ProbeStats {
  catalogItems: number;
  chapters: number;
  readers: number;
  series: number;
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
let randomState = seed || 0x9e37_79b9;

const random = (): number => {
  randomState ^= randomState << 13;
  randomState ^= randomState >>> 17;
  randomState ^= randomState << 5;
  return (randomState >>> 0) / 0x1_0000_0000;
};

const randomInteger = (minimum: number, maximum: number): number =>
  minimum + Math.floor(random() * (maximum - minimum + 1));

const pick = <T>(values: readonly T[]): T => {
  assert.ok(values.length > 0, "Cannot select from an empty collection.");
  return values[Math.floor(random() * values.length)]!;
};

const sampleUnique = <T>(values: readonly T[], count: number, key: (value: T) => string): T[] => {
  const unique = [...new Map(values.map((value) => [key(value), value])).values()];
  for (let index = unique.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [unique[index], unique[swapIndex]] = [unique[swapIndex]!, unique[index]!];
  }
  return unique.slice(0, count);
};

const headersFrom = (headers: Headers): Record<string, string> =>
  Object.fromEntries(headers.entries());

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
      const response = await fetch(request.url, {
        method: request.method ?? "GET",
        headers,
        body: typeof request.body === "string" ? request.body : undefined,
        redirect: "follow",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
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
  source: string,
  items: readonly CatalogItem[],
  load: (mangaId: string) => Promise<{ chapters: Chapter[]; manga: SourceManga }>,
  read: (chapter: Chapter) => Promise<ChapterDetails>,
  readable: (chapter: Chapter) => boolean = () => true,
): Promise<ProbeStats> => {
  assert.ok(items.length > 0, `${source} returned an empty randomized catalog sample.`);
  const selected = sampleUnique(items, samplesPerSource, (item) => item.mangaId);
  assert.ok(selected.length > 0, `${source} did not expose a unique title to probe.`);
  const stats: ProbeStats = { catalogItems: items.length, chapters: 0, readers: 0, series: 0 };

  for (const item of selected) {
    const { manga, chapters } = await load(item.mangaId);
    validateManga(manga);
    validateChapters(manga, chapters);
    stats.series += 1;
    stats.chapters += chapters.length;

    const candidates = chapters.filter(readable);
    if (candidates.length === 0) continue;
    const chapter = pick(candidates);
    validateReader(chapter, await read(chapter));
    stats.readers += 1;
  }
  return stats;
};

const searchTerms = ["", "a", "dragon", "love", "mage", "return", "sword"] as const;

const probeAtsumaru = async (): Promise<ProbeStats> => {
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
          title: index === 0 ? "" : pick(searchTerms),
          metadata: { adult: "safe" },
        },
        { id: pick(sorts), label: "Random probe" },
        index === 0 ? randomInteger(1, 8) : randomInteger(1, 3),
      ),
    ),
  );
  const items = pages.flatMap((page) => page.items);
  return probeSeries(
    "Atsumaru",
    items,
    async (mangaId) => {
      const manga = await client.getMangaDetails(mangaId);
      return { manga, chapters: await client.getChapters(manga) };
    },
    (chapter) => client.getChapterDetails(chapter),
  );
};

const probeMadaraDex = async (): Promise<ProbeStats> => {
  const client = new MadaraDexClient();
  const sorts = ["latest", "alphabet", "rating", "trending", "views", "new-manga"] as const;
  const pages = await Promise.all([
    client.getCatalogPage(
      { title: "" },
      { id: pick(sorts), label: "Random probe" },
      randomInteger(1, 5),
    ),
    client.getCatalogPage(
      { title: pick(searchTerms) },
      { id: pick(sorts), label: "Random probe" },
      randomInteger(1, 2),
    ),
  ]);
  const items = pages.flatMap((page) => page.items);
  return probeSeries(
    "MadaraDex",
    items,
    async (mangaId) => {
      const manga = await client.getMangaDetails(mangaId);
      return { manga, chapters: await client.getChapters(manga) };
    },
    (chapter) => client.getChapterDetails(chapter),
  );
};

const probeMgeko = async (): Promise<ProbeStats> => {
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
      { id: pick(sorts), label: "Random probe" },
      randomInteger(1, 8),
      true,
    ),
    client.getBrowsePage(
      { title: pick(searchTerms) },
      { id: pick(sorts), label: "Random probe" },
      randomInteger(1, 3),
      true,
    ),
  ]);
  const items = pages.flatMap((page) => page.items);
  return probeSeries(
    "Mgeko",
    items,
    async (mangaId) => {
      const manga = await client.getMangaDetails(mangaId);
      return { manga, chapters: await client.getChapters(manga) };
    },
    (chapter) => client.getChapterDetails(chapter),
  );
};

const probeThunder = async (): Promise<ProbeStats> => {
  const client = new ThunderClient();
  const sorts = ["update", "latest", "popular", "title", "titlereverse"] as const;
  const pages = await Promise.all([
    client.getDirectoryPage(
      { title: "" },
      { id: pick(sorts), label: "Random probe" },
      randomInteger(1, 5),
    ),
    client.getDirectoryPage({ title: pick(searchTerms) }, undefined, randomInteger(1, 2)),
  ]);
  const items = pages.flatMap((page) => page.items);
  return probeSeries(
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

const probeVortex = async (): Promise<ProbeStats> => {
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
      { id: pick(sorts), label: "Random probe" },
      randomInteger(1, 5),
    ),
    fetchVortexSearchPage(
      { title: pick(searchTerms), metadata: { direction: ["desc"] } },
      { id: pick(sorts), label: "Random probe" },
      randomInteger(1, 2),
    ),
  ]);
  const items = pages.flatMap(parseVortexMangaList);
  return probeSeries(
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

const probes = [
  ["Atsumaru", probeAtsumaru],
  ["MadaraDex", probeMadaraDex],
  ["Mgeko", probeMgeko],
  ["Thunder", probeThunder],
  ["Vortex", probeVortex],
] as const;

const failures: Error[] = [];
output(`Random live seed: ${seed} (0x${seed.toString(16).padStart(8, "0")})`);
output(`Samples per source: ${samplesPerSource}`);

try {
  for (const [name, probe] of probes) {
    const started = performance.now();
    try {
      const stats = await probe();
      output(
        `${name}: ${stats.series} series, ${stats.chapters} chapters, ${stats.readers} readers ` +
          `from ${stats.catalogItems} catalog items (${Math.round(performance.now() - started)}ms)`,
      );
    } catch (error: unknown) {
      const failure = error instanceof Error ? error : new Error(String(error));
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

output("All randomized live probes passed.");
