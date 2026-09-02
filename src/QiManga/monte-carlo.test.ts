import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  ContentRating,
  type Chapter,
  type Request,
  type Response,
  type SourceManga,
} from "@paperback/types";

import { QiMangaClient } from "./client.js";
import {
  API_BASE_URL,
  buildSeriesUrl,
  isValidSeriesSlug,
  parseSeriesUrl,
  seriesIdToSlug,
  seriesSlugToId,
} from "./network.js";
import {
  finalizeChapters,
  parseChapterDetails,
  parseChapterPage,
  parseSeriesPage,
} from "./parsers.js";

const originalApplication = globalThis.Application;

afterEach(() => Object.assign(globalThis, { Application: originalApplication }));

class DeterministicRandom {
  constructor(private state: number) {
    this.state >>>= 0;
    if (this.state === 0) this.state = 0x9e3779b9;
  }

  nextUint32(): number {
    let value = this.state;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    this.state = value >>> 0;
    return this.state;
  }

  integer(maximumExclusive: number): number {
    return this.nextUint32() % maximumExclusive;
  }

  boolean(): boolean {
    return (this.nextUint32() & 1) === 1;
  }

  pick<T>(values: readonly T[]): T {
    return values[this.integer(values.length)]!;
  }

  shuffle<T>(values: readonly T[]): T[] {
    const result = [...values];
    for (let index = result.length - 1; index > 0; index -= 1) {
      const target = this.integer(index + 1);
      [result[index], result[target]] = [result[target]!, result[index]!];
    }
    return result;
  }
}

const SEEDS = [0x00c0ffee, 0x12345678, 0x5eed5eed, 0x7f4a7c15, 0xdeadbeef] as const;
const ALLOWED_MEDIA_HOSTS = new Set([
  "media.qimanga.com",
  "media.qiscans.org",
  "media.qimanhwa.com",
  "media.ezmanga.org",
  "media.quantumscans.org",
]);
const seedMessage = (seed: number, iteration: number): string =>
  `seed=0x${seed.toString(16).padStart(8, "0")}, iteration=${iteration}`;

const sourceManga: SourceManga = {
  mangaId: "simulation-series",
  mangaInfo: {
    primaryTitle: "Simulation Series",
    secondaryTitles: [],
    thumbnailUrl: "https://media.qimanga.com/simulation.webp",
    synopsis: "",
    contentRating: ContentRating.EVERYONE,
    contentType: "comic",
  },
};

const novelManga: SourceManga = {
  ...sourceManga,
  mangaId: "simulation-novel",
  mangaInfo: { ...sourceManga.mangaInfo, contentType: "novel" },
};

const randomSlug = (random: DeterministicRandom): string => {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789-!:'()";
  const length = 1 + random.integer(80);
  let value = "";
  for (let index = 0; index < length; index += 1)
    value += alphabet[random.integer(alphabet.length)];
  return value === "." || value === ".." ? `series-${value.length}` : value;
};

describe("Qi Manga deterministic Monte Carlo ID boundaries", () => {
  it("round-trips generated live-alphabet slugs through IDs, API routes, and pasted URLs", () => {
    for (const seed of SEEDS) {
      const random = new DeterministicRandom(seed);
      for (let iteration = 0; iteration < 400; iteration += 1) {
        const slug = randomSlug(random);
        const message = seedMessage(seed, iteration);
        assert.equal(isValidSeriesSlug(slug), true, message);
        const mangaId = seriesSlugToId(slug);
        assert.equal(seriesIdToSlug(mangaId), slug, message);
        assert.ok(mangaId.length <= 256, message);
        assert.doesNotMatch(mangaId, /[/?#\\\s]/u, message);

        const apiUrl = buildSeriesUrl(mangaId);
        const parsedApiUrl = new URL(apiUrl);
        assert.equal(parsedApiUrl.origin, "https://api.qimanga.com", message);
        assert.equal(
          decodeURIComponent(parsedApiUrl.pathname.split("/").at(-1) ?? ""),
          slug,
          message,
        );

        const pasted = `https://qimanga.com/series/${mangaId}?seed=${seed}`;
        assert.equal(parseSeriesUrl(pasted), mangaId, message);
      }
    }
  });

  it("rejects generated path, authority, control, and encoded-delimiter mutations", () => {
    const invalidFragments = ["/", "?", "#", "\\", " ", "\n", "\u0000", "%2f", "%2e", "%5c"];
    for (const seed of SEEDS) {
      const random = new DeterministicRandom(seed ^ 0xa5a5a5a5);
      for (let iteration = 0; iteration < 200; iteration += 1) {
        const invalid = `${randomSlug(random)}${random.pick(invalidFragments)}${randomSlug(random)}`;
        const message = seedMessage(seed, iteration);
        assert.equal(isValidSeriesSlug(invalid), false, message);
        assert.throws(() => seriesSlugToId(invalid), /slug is invalid/i, message);
      }
    }
    assert.equal(isValidSeriesSlug("!".repeat(86)), false, "encoded length must remain bounded");
  });
});

describe("Qi Manga deterministic Monte Carlo parser invariants", () => {
  it("keeps chapter normalization unique, sorted, stable, and non-mutating", () => {
    for (const seed of SEEDS) {
      const random = new DeterministicRandom(seed);
      for (let iteration = 0; iteration < 120; iteration += 1) {
        const uniqueCount = 1 + random.integer(50);
        const unique: Chapter[] = Array.from({ length: uniqueCount }, (_, index) => {
          const chapNum = random.integer(30) + random.integer(10) / 10;
          return {
            chapterId: `chapter-${index}-${random.integer(1_000_000)}`,
            sourceManga,
            langCode: "en",
            chapNum,
            ...(random.boolean() && {
              publishDate: new Date(1_700_000_000_000 + random.integer(10_000_000)),
            }),
          };
        });
        const withDuplicates = [
          ...unique,
          ...Array.from({ length: random.integer(uniqueCount + 1) }, () => ({
            ...random.pick(unique),
          })),
        ];
        const shuffled = random.shuffle(withDuplicates);
        const originalOrder = shuffled.map((chapter) => chapter.chapterId);
        const normalized = finalizeChapters(shuffled);
        const message = seedMessage(seed, iteration);

        assert.deepEqual(
          shuffled.map((chapter) => chapter.chapterId),
          originalOrder,
          message,
        );
        assert.equal(normalized.length, new Set(originalOrder).size, message);
        assert.equal(
          new Set(normalized.map((chapter) => chapter.chapterId)).size,
          normalized.length,
          message,
        );
        assert.deepEqual(
          normalized.map((chapter) => chapter.sortingIndex),
          normalized.map((_, index) => index),
          message,
        );
        for (let index = 1; index < normalized.length; index += 1) {
          const left = normalized[index - 1]!;
          const right = normalized[index]!;
          const ordered =
            left.chapNum < right.chapNum ||
            (left.chapNum === right.chapNum &&
              ((left.publishDate?.getTime() ?? 0) < (right.publishDate?.getTime() ?? 0) ||
                ((left.publishDate?.getTime() ?? 0) === (right.publishDate?.getTime() ?? 0) &&
                  left.chapterId <= right.chapterId)));
          assert.equal(ordered, true, message);
        }
        assert.deepEqual(finalizeChapters(shuffled), normalized, message);
      }
    }
  });

  it("conservatively derives every generated paid/free state combination", () => {
    const states: readonly unknown[] = [true, false, undefined, null, 0, 1, "true", "false"];
    for (const seed of SEEDS) {
      const random = new DeterministicRandom(seed);
      for (let iteration = 0; iteration < 300; iteration += 1) {
        const isFree = random.pick(states);
        const requiresPurchase = random.pick(states);
        const requiresAuth = random.pick(states);
        const response = {
          data: [
            {
              slug: `chapter-${iteration}`,
              number: iteration + 1,
              isFree,
              requiresPurchase,
              requiresAuth,
              price: 25,
            },
          ],
          current: 1,
          totalPages: 1,
          totalItems: 1,
        };
        const visible = parseChapterPage(response, sourceManga, true).chapters;
        const freeOnly = parseChapterPage(response, sourceManga, false).chapters;
        const expectedLocked =
          requiresPurchase !== false ||
          requiresAuth === true ||
          (requiresAuth !== undefined && typeof requiresAuth !== "boolean");
        const message = seedMessage(seed, iteration);
        assert.equal(visible.length, 1, message);
        assert.equal(visible[0]?.additionalInfo?.locked, String(expectedLocked), message);
        assert.equal(freeOnly.length, expectedLocked ? 0 : 1, message);
      }
    }
  });

  it("orders and deduplicates valid reader pages while rejecting any unsafe image entry", () => {
    for (const seed of SEEDS) {
      const random = new DeterministicRandom(seed);
      for (let iteration = 0; iteration < 140; iteration += 1) {
        const rawImages = Array.from({ length: 1 + random.integer(60) }, (_, index) => {
          const kind = random.integer(6);
          const url =
            kind === 0
              ? `http://media.qimanga.com/${random.integer(20)}.webp`
              : kind === 1
                ? `javascript:alert(${index})`
                : kind === 2
                  ? `/relative/${random.integer(20)}.webp`
                  : kind === 3
                    ? `https://tracker.example/${random.integer(20)}.webp`
                    : `https://media.qimanga.com/${random.integer(20)}.webp`;
          return { url, order: random.integer(30) };
        });
        const chapter: Chapter = {
          chapterId: `chapter-${iteration}`,
          sourceManga,
          langCode: "en",
          chapNum: iteration,
        };
        const sorted = rawImages
          .map((image, inputIndex) => ({ ...image, inputIndex }))
          .sort((left, right) => left.order - right.order || left.inputIndex - right.inputIndex);
        const seen = new Set<string>();
        const expected = sorted.flatMap(({ url }): string[] => {
          let parsed: URL;
          try {
            parsed = new URL(url, "https://qimanga.com");
          } catch {
            return [];
          }
          if (
            parsed.protocol !== "https:" ||
            !ALLOWED_MEDIA_HOSTS.has(parsed.hostname) ||
            seen.has(parsed.href)
          ) {
            return [];
          }
          seen.add(parsed.href);
          return [parsed.href];
        });
        const message = seedMessage(seed, iteration);
        const hasUnsafeEntry = rawImages.some(({ url }) => {
          try {
            const parsed = new URL(url, "https://qimanga.com");
            return parsed.protocol !== "https:" || !ALLOWED_MEDIA_HOSTS.has(parsed.hostname);
          } catch {
            return true;
          }
        });
        const response = {
          slug: chapter.chapterId,
          series: { slug: "simulation-series" },
          number: chapter.chapNum,
          isFree: true,
          requiresPurchase: false,
          images: rawImages,
        };
        if (hasUnsafeEntry) {
          assert.throws(
            () => parseChapterDetails(response, chapter),
            /invalid chapter image entry/i,
            message,
          );
          continue;
        }
        const details = parseChapterDetails(response, chapter);
        assert.ok("pages" in details, message);
        if (!("pages" in details)) assert.fail(message);
        assert.deepEqual(details.pages, expected, message);
        assert.equal(new Set(details.pages).size, details.pages.length, message);
        assert.ok(
          details.pages.every((page) => new URL(page).protocol === "https:"),
          message,
        );
      }
    }
  });

  it("contains generated active novel markup without losing safe text", () => {
    const attacks = [
      "<script>attack()</script>",
      '<img src="x" onerror="attack()">',
      '<a href="javascript:attack()">click</a>',
      '<iframe src="https://evil.test"></iframe>',
      "<style>body{display:none}</style>",
    ];
    for (const seed of SEEDS) {
      const random = new DeterministicRandom(seed);
      for (let iteration = 0; iteration < 100; iteration += 1) {
        const marker = `safe-${seed}-${iteration}`;
        const chapter: Chapter = {
          chapterId: `chapter-${iteration}`,
          sourceManga: novelManga,
          langCode: "en",
          chapNum: iteration,
        };
        const details = parseChapterDetails(
          {
            slug: chapter.chapterId,
            series: { slug: "simulation-novel" },
            number: chapter.chapNum,
            isFree: true,
            requiresPurchase: false,
            images: [],
            content: `<p>${marker}</p>${random.pick(attacks)}`,
          },
          chapter,
        );
        const message = seedMessage(seed, iteration);
        assert.ok("html" in details, message);
        if (!("html" in details)) assert.fail(message);
        assert.match(details.html, new RegExp(marker), message);
        assert.doesNotMatch(
          details.html,
          /<script|<iframe|<style|\sonerror=|javascript:/i,
          message,
        );
      }
    }
  });

  it("fails closed or returns bounded cards for randomized untrusted envelopes", () => {
    const scalarValues: readonly unknown[] = [
      null,
      undefined,
      true,
      false,
      0,
      -1,
      1,
      "1",
      "x",
      {},
      [],
    ];
    for (const seed of SEEDS) {
      const random = new DeterministicRandom(seed);
      for (let iteration = 0; iteration < 300; iteration += 1) {
        const dataLength = random.integer(230);
        const data = Array.from({ length: dataLength }, (_, index) => ({
          slug: random.boolean() ? randomSlug(random) : random.pick(scalarValues),
          title: random.boolean() ? `Title ${index}` : random.pick(scalarValues),
          cover: random.boolean()
            ? `https://media.qimanga.com/${index}.webp`
            : random.pick(scalarValues),
          redirectUrl: random.integer(8) === 0 ? "https://external.example/title" : null,
          avgRating: random.pick([0, 1, 2.5, 5, 99, Number.NaN, "4.5"]),
        }));
        const envelope = {
          data,
          current: random.pick([1, "1", 2, 0, -1, "bad"]),
          totalPages: random.pick([0, 1, 5, "2", -1, "bad"]),
          totalItems: random.pick([0, dataLength, String(dataLength), -1]),
        };
        const message = seedMessage(seed, iteration);
        try {
          const page = parseSeriesPage(envelope);
          assert.ok(page.page >= 1, message);
          assert.ok(page.pageCount >= 0, message);
          assert.ok(page.items.length <= 200, message);
          assert.equal(
            new Set(page.items.map((item) => item.mangaId)).size,
            page.items.length,
            message,
          );
          assert.ok(
            page.items.every((item) => new URL(item.imageUrl).protocol === "https:"),
            message,
          );
        } catch (error: unknown) {
          assert.ok(error instanceof Error, message);
          assert.match(error.message, /^Qi Manga /, message);
        }
      }
    }
  });
});

describe("Qi Manga deterministic Monte Carlo pagination simulation", () => {
  it("visits every dynamically declared chapter page exactly once without truncation", async () => {
    for (const seed of SEEDS) {
      const random = new DeterministicRandom(seed);
      for (let iteration = 0; iteration < 24; iteration += 1) {
        const finalPageCount = iteration === 0 ? 40 : 1 + random.integer(12);
        const chaptersPerPage = 1 + random.integer(6);
        const totalItems = finalPageCount * chaptersPerPage;
        const requestedPages: number[] = [];

        Object.assign(globalThis, {
          Application: {
            arrayBufferToUTF8String: (buffer: ArrayBuffer) => new TextDecoder().decode(buffer),
            scheduleRequest: async (request: Request): Promise<[Response, ArrayBuffer]> => {
              assert.ok(request.url.startsWith(API_BASE_URL), seedMessage(seed, iteration));
              const page = Number(new URL(request.url).searchParams.get("page") ?? 1);
              requestedPages.push(page);
              const body = {
                data: Array.from({ length: chaptersPerPage }, (_, index) => {
                  const ordinal = (page - 1) * chaptersPerPage + index + 1;
                  return {
                    slug: `chapter-${ordinal}`,
                    number: ordinal,
                    isFree: true,
                    requiresPurchase: false,
                    createdAt: `2026-01-${String((ordinal % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
                  };
                }),
                current: page,
                totalPages: finalPageCount,
                totalItems,
              };
              return [
                { url: request.url, status: 200, headers: {}, cookies: [] },
                new TextEncoder().encode(JSON.stringify(body)).buffer,
              ];
            },
          },
        });

        const chapters = await new QiMangaClient().getChapters(sourceManga, { showLocked: true });
        const message = seedMessage(seed, iteration);
        assert.equal(chapters.length, totalItems, message);
        assert.deepEqual(
          [...requestedPages].sort((left, right) => left - right),
          Array.from({ length: finalPageCount }, (_, index) => index + 1),
          message,
        );
        assert.deepEqual(
          chapters.map((chapter) => chapter.sortingIndex),
          chapters.map((_, index) => index),
          message,
        );
      }
    }
  });
});
