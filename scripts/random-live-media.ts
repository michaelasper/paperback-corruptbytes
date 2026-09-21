import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";

import type {
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
  fetchGenres as fetchVortexGenres,
  fetchPostDetails as fetchVortexPostDetails,
  fetchSearchPage as fetchVortexSearchPage,
} from "../src/VortexScans/client.js";
import {
  parseMangaDetails as parseVortexMangaDetails,
  parseMangaList as parseVortexMangaList,
} from "../src/VortexScans/parsers.js";
import {
  createDeterministicRandom,
  deriveDeterministicSeed,
  type DeterministicRandom,
  runBoundedTasks,
} from "./random-runtime.js";

/**
 * Randomized live probe for taxonomy and media surfaces: genres, tags, filtered
 * catalog pages, and cover/thumbnail image bytes. Complements random-live.ts
 * (which focuses on chapters and readers) by verifying that every sampled
 * taxonomy filter still returns results and that every sampled cover URL still
 * serves a real image payload.
 */

const USER_AGENT = "Mozilla/5.0 PaperbackExtensionRandomLive/1.0";
const REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_SAMPLES_PER_SOURCE = 4;
const MAX_SAMPLES_PER_SOURCE = 8;
const DEFAULT_SOURCE_CONCURRENCY = 3;
const MAX_SOURCE_CONCURRENCY = 7;
const MAX_GENRE_FILTERS_PER_SOURCE = 3;
const MAX_DETAIL_SERIES_PER_SOURCE = 2;

interface CatalogCard {
  mangaId: string;
  title: string;
  imageUrl: string;
}

interface MediaStats {
  genres: number;
  tags: number;
  genreFiltersTried: number;
  genreFiltersWithResults: number;
  filteredResults: number;
  tagFilterResults: number;
  coversChecked: number;
  detailSeries: number;
  detailTagValues: number;
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

const hasImageSignature = (bytes: Uint8Array): boolean =>
  (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) ||
  (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) ||
  (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) ||
  (bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50) ||
  (bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70);

const fetchCoverBytes = async (source: string, url: string): Promise<void> => {
  const response = await fetch(url, {
    headers: { "user-agent": USER_AGENT },
    redirect: "follow",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  assert.equal(
    response.status,
    200,
    `${source} cover request failed with HTTP ${response.status}: ${url}`,
  );
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.ok(
    bytes.byteLength > 500,
    `${source} cover payload was only ${bytes.byteLength} bytes: ${url}`,
  );
  assert.ok(
    hasImageSignature(bytes),
    `${source} cover payload did not match a known image signature: ${url}`,
  );
};

const validateCards = (source: string, cards: readonly CatalogCard[]): void => {
  cards.forEach((card) => {
    assert.ok(card.mangaId.length > 0, `${source} returned a catalog card without an ID.`);
    assert.ok(card.title.trim().length > 0, `${source} card ${card.mangaId} had no title.`);
    assert.match(
      card.imageUrl,
      /^https:\/\//,
      `${source} card ${card.mangaId} had a non-HTTPS cover: ${card.imageUrl}`,
    );
  });
};

const probeCovers = async (
  random: DeterministicRandom,
  source: string,
  urls: readonly string[],
): Promise<number> => {
  const unique = [...new Set(urls)];
  assert.ok(unique.length > 0, `${source} exposed no cover URLs to sample.`);
  const selected = random.sampleUnique(
    unique,
    Math.min(samplesPerSource, unique.length),
    (url) => url,
  );
  for (const url of selected) await fetchCoverBytes(source, url);
  return selected.length;
};

const probeDetails = async (source: string, manga: SourceManga): Promise<number> => {
  assert.match(
    manga.mangaInfo.thumbnailUrl,
    /^https:\/\//,
    `${source} detail ${manga.mangaId} had a non-HTTPS cover.`,
  );
  await fetchCoverBytes(source, manga.mangaInfo.thumbnailUrl);
  const groups = manga.mangaInfo.tagGroups ?? [];
  assert.ok(
    Array.isArray(groups),
    `${source} detail ${manga.mangaId} did not expose a tag group array.`,
  );
  for (const group of groups) {
    assert.ok(
      group.id.trim().length > 0,
      `${source} detail ${manga.mangaId} had a tag group without an ID.`,
    );
    assert.ok(
      group.title.trim().length > 0,
      `${source} detail ${manga.mangaId} tag group ${group.id} had no title.`,
    );
    for (const tag of group.tags) {
      assert.ok(
        tag.id.trim().length > 0,
        `${source} detail ${manga.mangaId} returned a tag without an ID.`,
      );
      assert.ok(
        tag.title.trim().length > 0,
        `${source} detail ${manga.mangaId} tag ${tag.id} had no title.`,
      );
    }
  }
  return groups.reduce((total, group) => total + group.tags.length, 0);
};

const validateTaxonomy = <T extends { id: string }>(
  source: string,
  kind: string,
  values: readonly T[],
  labelOf: (value: T) => string,
): void => {
  assert.ok(values.length > 0, `${source} returned an empty ${kind} taxonomy.`);
  const ids = new Set<string>();
  for (const value of values) {
    assert.ok(value.id.trim().length > 0, `${source} returned a ${kind} without an ID.`);
    assert.ok(labelOf(value).trim().length > 0, `${source} ${kind} ${value.id} had no label.`);
    ids.add(value.id);
  }
  assert.equal(ids.size, values.length, `${source} returned duplicate ${kind} IDs.`);
};

const initStats = (genres: number, tags: number): MediaStats => ({
  genres,
  tags,
  genreFiltersTried: 0,
  genreFiltersWithResults: 0,
  filteredResults: 0,
  tagFilterResults: 0,
  coversChecked: 0,
  detailSeries: 0,
  detailTagValues: 0,
});

/** Shared genre-filter / cover / detail sampling shared by every source probe. */
const probeGenreFiltering = async (
  random: DeterministicRandom,
  source: string,
  stats: MediaStats,
  genres: readonly { id: string }[],
  loadFilteredPage: (genreId: string) => Promise<readonly CatalogCard[]>,
  loadDetails: (mangaId: string) => Promise<SourceManga>,
): Promise<void> => {
  const candidates = random.sampleUnique(
    genres,
    Math.min(MAX_GENRE_FILTERS_PER_SOURCE, genres.length),
    (genre) => genre.id,
  );
  const cards: CatalogCard[] = [];
  for (const genre of candidates) {
    stats.genreFiltersTried += 1;
    const items = await loadFilteredPage(genre.id);
    validateCards(source, items);
    if (items.length > 0) stats.genreFiltersWithResults += 1;
    cards.push(...items);
  }
  assert.ok(
    stats.genreFiltersWithResults > 0,
    `${source} returned no results for any of ${stats.genreFiltersTried} sampled genre filters.`,
  );
  stats.filteredResults = cards.length;

  const uniqueCards = [...new Map(cards.map((card) => [card.mangaId, card])).values()];
  stats.coversChecked = await probeCovers(
    random,
    source,
    uniqueCards.map((card) => card.imageUrl),
  );

  const detailed = random.sampleUnique(
    uniqueCards,
    Math.min(MAX_DETAIL_SERIES_PER_SOURCE, uniqueCards.length),
    (card) => card.mangaId,
  );
  for (const card of detailed) {
    stats.detailTagValues += await probeDetails(source, await loadDetails(card.mangaId));
    stats.detailSeries += 1;
  }
  assert.ok(
    stats.detailSeries === 0 || stats.detailTagValues > 0,
    `${source} sampled details exposed no parsed tag values at all.`,
  );
};

const probeAtsumaru = async (random: DeterministicRandom): Promise<MediaStats> => {
  const client = new AtsumaruClient();
  const filters = await client.getFilterOptions();
  validateTaxonomy("Atsumaru", "genre", filters.genres, (genre) => genre.name);
  validateTaxonomy("Atsumaru", "tag", filters.tags, (tag) => tag.name);
  const stats = initStats(filters.genres.length, filters.tags.length);

  const sorts = [
    "relevance",
    "title",
    "most-viewed",
    "trending",
    "recently-added",
    "released",
    "topRated",
  ] as const;
  const sorting = { id: random.pick(sorts), label: "Random probe" };
  await probeGenreFiltering(
    random,
    "Atsumaru",
    stats,
    filters.genres,
    async (genreId) =>
      (
        await client.getSearchPage(
          { title: "", metadata: { adult: "safe", genres: { [genreId]: "included" } } },
          sorting,
          1,
        )
      ).items,
    async (mangaId) => client.getMangaDetails(mangaId),
  );

  const tag = random.pick(filters.tags);
  const tagPage = await client.getSearchPage(
    { title: "", metadata: { adult: "safe", tags: { [tag.id]: "included" } } },
    sorting,
    1,
  );
  validateCards("Atsumaru", tagPage.items);
  stats.tagFilterResults = tagPage.items.length;
  return stats;
};

const probeMadaraDex = async (random: DeterministicRandom): Promise<MediaStats> => {
  const client = new MadaraDexClient();
  const filters = await client.getFilterOptions();
  validateTaxonomy("MadaraDex", "genre", filters.genres, (genre) => genre.title);
  validateTaxonomy("MadaraDex", "status", filters.statuses, (status) => status.title);
  const stats = initStats(filters.genres.length, 0);

  await probeGenreFiltering(
    random,
    "MadaraDex",
    stats,
    filters.genres,
    async (genreId) =>
      (
        await client.getCatalogPage(
          { title: "", metadata: { genres: [genreId] } },
          { id: "latest", label: "Random probe" },
          1,
        )
      ).items,
    async (mangaId) => client.getMangaDetails(mangaId),
  );
  return stats;
};

const probeMgeko = async (random: DeterministicRandom): Promise<MediaStats> => {
  const client = new MgekoClient();
  const filters = await client.getFilterOptions();
  validateTaxonomy("Mgeko", "genre", filters.genres, (genre) => genre.title);
  validateTaxonomy("Mgeko", "status", filters.statuses, (status) => status.title);
  const stats = initStats(filters.genres.length, 0);

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
  await probeGenreFiltering(
    random,
    "Mgeko",
    stats,
    filters.genres,
    async (genreId) =>
      (
        await client.getBrowsePage(
          { title: "", metadata: { genres: { [genreId]: "included" } } },
          { id: random.pick(sorts), label: "Random probe" },
          1,
          true,
        )
      ).items,
    async (mangaId) => client.getMangaDetails(mangaId),
  );
  return stats;
};

const probeThunder = async (random: DeterministicRandom): Promise<MediaStats> => {
  const client = new ThunderClient();
  const genres = await client.getGenres();
  validateTaxonomy("Thunder", "genre", genres, (genre) => genre.title);
  const stats = initStats(genres.length, 0);

  const sorts = ["update", "latest", "popular", "title", "titlereverse"] as const;
  await probeGenreFiltering(
    random,
    "Thunder",
    stats,
    genres,
    async (genreId) =>
      (
        await client.getDirectoryPage(
          { title: "", metadata: { genres: { [genreId]: "included" } } },
          { id: random.pick(sorts), label: "Random probe" },
          1,
        )
      ).items,
    async (mangaId) => client.getMangaDetails(mangaId),
  );
  return stats;
};

const probeVortex = async (random: DeterministicRandom): Promise<MediaStats> => {
  const genres = await fetchVortexGenres();
  validateTaxonomy("Vortex", "genre", genres, (genre) => genre.title);
  const stats = initStats(genres.length, 0);

  const sorts = [
    "lastChapterAddedAt",
    "totalViews",
    "createdAt",
    "chaptersCount",
    "postTitle",
  ] as const;
  await probeGenreFiltering(
    random,
    "Vortex",
    stats,
    genres,
    async (genreId) =>
      parseVortexMangaList(
        await fetchVortexSearchPage(
          { title: "", metadata: { genres: { [genreId]: "included" }, direction: ["desc"] } },
          { id: random.pick(sorts), label: "Random probe" },
          1,
        ),
      ),
    async (mangaId) => {
      const response = await fetchVortexPostDetails(mangaId);
      return parseVortexMangaDetails(response.post ?? response, mangaId);
    },
  );
  return stats;
};

const probeNovelDash = async (
  site: NovelDashSite,
  random: DeterministicRandom,
): Promise<MediaStats> => {
  const client = new NovelDashClient(site);
  const genres = await client.getGenres();
  validateTaxonomy(site.name, "genre", genres, (genre) => genre.title);
  const stats = initStats(genres.length, 0);

  const sorts = ["updated", "trending", "popular", "views", "rating", "longest", "newest"];
  // These white-label sites share relatively expensive database-backed sort routes. Keep their
  // randomized taxonomy probes sequential so the test does not create its own timeout condition.
  await probeGenreFiltering(
    random,
    site.name,
    stats,
    genres,
    async (genreId) =>
      (
        await client.getCatalogPage(
          { title: "", metadata: { genres: { [genreId]: "included" } } },
          { id: random.pick(sorts), label: "Random probe" },
          1,
        )
      ).items,
    async (mangaId) => client.getMangaDetails(mangaId),
  );
  return stats;
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

const formatStats = (stats: MediaStats): string =>
  `${stats.genres} genres` +
  (stats.tags > 0 ? `, ${stats.tags} tags` : "") +
  `, ${stats.genreFiltersWithResults}/${stats.genreFiltersTried} genre filters matched (${stats.filteredResults} cards)` +
  (stats.tagFilterResults > 0 ? `, tag filter matched ${stats.tagFilterResults} cards` : "") +
  `, ${stats.coversChecked} covers OK` +
  `, ${stats.detailSeries} details with ${stats.detailTagValues} tag values`;

const failures: Error[] = [];
output(`Random live media seed: ${seed} (0x${seed.toString(16).padStart(8, "0")})`);
output(`Cover samples per source: ${samplesPerSource}`);
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
      output(`${name}: ${formatStats(stats)} (${elapsedMs}ms)`);
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
  throw new AggregateError(failures, `${failures.length} randomized media probe(s) failed.`);
}

output(
  `All randomized taxonomy and media probes passed in ${Math.round(performance.now() - allStarted)}ms.`,
);
