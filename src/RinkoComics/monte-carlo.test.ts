import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CDN_DOMAIN,
  DOMAIN,
  decodeRinkoChapterId,
  decodeRinkoMangaId,
  encodeRinkoChapterId,
  encodeRinkoMangaId,
  isRinkoCoverUrl,
  isRinkoMediaUrl,
  normalizeSearchTerm,
} from "./network.js";
import { parseChapterDetails } from "./parsers.js";

const SEED = 0x51c0_2026;

const generator = (initialSeed: number): (() => number) => {
  let state = initialSeed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state;
  };
};

const random = generator(SEED);
const pick = <T>(values: readonly T[]): T => values[random() % values.length]!;

const SLUG_CHARACTERS = [
  ...Array.from("abcdefghijklmnopqrstuvwxyz0123456789-_"),
  "é",
  "花",
  "한",
  "!",
  "'",
  "(",
  ")",
  "*",
  "~",
] as const;

const randomSlug = (): string => {
  const length = 1 + (random() % 40);
  return Array.from({ length }, () => pick(SLUG_CHARACTERS)).join("");
};

const readerHtml = (pageCount: number): string => {
  const images = Array.from({ length: pageCount }, (_, index) => {
    const page = index + 1;
    return `<img class="chapter-image lazy-image" data-page="${page}" data-src="${CDN_DOMAIN}/wp-content/uploads/comics/property-series/40/${String(page).padStart(3, "0")}_${random().toString(16)}.webp">`;
  }).join("");
  return `<html><head>
    <link rel="canonical" href="${DOMAIN}/chapter/property-series-chapter-40/">
    <link rel="alternate" type="application/json" href="${DOMAIN}/wp-json/wp/v2/chapters/22182">
  </head><body>
    <h1 class="chapter-title">Property Series Chapter 40 <span class="chapter-tag free">Free</span></h1>
    <span class="status-message">Ready to read</span>
    <span class="pages-count">${pageCount} pages</span>
    <div class="chapter-images-section"><div class="chapter-images-outer"><div class="images-flow">${images}</div></div></div>
  </body></html>`;
};

describe("Rinko Comics seeded invariants", () => {
  it("round-trips bounded opaque composite IDs without collisions", () => {
    const mangaIds = new Set<string>();
    const chapterIds = new Set<string>();
    for (let index = 0; index < 2_000; index += 1) {
      const slug = `${randomSlug()}-${index}`;
      const postId = String(1 + (random() % 2_000_000_000));
      const mangaId = encodeRinkoMangaId(slug, postId);
      const chapterId = encodeRinkoChapterId(`${slug}-chapter-${index + 1}`, postId);
      assert.deepEqual(decodeRinkoMangaId(mangaId), { slug, postId });
      assert.deepEqual(decodeRinkoChapterId(chapterId), {
        slug: `${slug}-chapter-${index + 1}`,
        postId,
      });
      assert.equal(mangaIds.has(mangaId), false);
      assert.equal(chapterIds.has(chapterId), false);
      mangaIds.add(mangaId);
      chapterIds.add(chapterId);
    }
  });

  it("keeps randomized traversal and credential-shaped media URLs outside the allowlist", () => {
    const attacks = ["..", ".", "%2e%2e", "%252e%252e", "%2f", "%252f", "%5c", "%255c"];
    for (let index = 0; index < 2_000; index += 1) {
      const safePath = `${randomSlug().replace(/[^a-z0-9_-]/gi, "x")}/${1 + (random() % 999)}`;
      const safeMedia = `${CDN_DOMAIN}/wp-content/uploads/comics/${safePath}/${index}.webp`;
      const safeCover = `${DOMAIN}/wp-content/uploads/${safePath}/${index}.webp`;
      assert.equal(isRinkoMediaUrl(safeMedia), true);
      assert.equal(isRinkoCoverUrl(safeCover), true);
      const attack = pick(attacks);
      assert.equal(
        isRinkoMediaUrl(
          `${CDN_DOMAIN}/wp-content/uploads/comics/${safePath}/${attack}/${index}.webp`,
        ),
        false,
      );
      assert.equal(isRinkoMediaUrl(`${safeMedia}?token=${random()}`), false);
      assert.equal(isRinkoCoverUrl(`${safeCover}#credential-${random()}`), false);
    }
  });

  it("normalizes search input deterministically and preserves reader image order", () => {
    const whitespace = [" ", "  ", "   ", "    "] as const;
    for (let index = 0; index < 250; index += 1) {
      const input = `Flower${pick(whitespace)}Path${index % 2 === 0 ? "’" : "'"}s`;
      const normalized = normalizeSearchTerm(input);
      assert.equal(normalizeSearchTerm(input), normalized);
      assert.equal(normalized, "Flower Path s");

      const count = 1 + (random() % 80);
      const details = parseChapterDetails(
        readerHtml(count),
        "property-series-chapter-40@22182",
        "property-series@13135",
        40,
        "Property Series Chapter 40",
      );
      assert.ok("pages" in details);
      assert.equal(details.pages.length, count);
      assert.deepEqual(
        details.pages.map((url) => Number(url.match(/\/(\d{3})_[^/]+\.webp$/)?.[1])),
        Array.from({ length: count }, (_, page) => page + 1),
      );
      assert.ok(details.pages.every((url) => isRinkoMediaUrl(url)));
    }
  });
});
