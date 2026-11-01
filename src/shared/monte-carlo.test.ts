import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { test } from "node:test";

import { ContentRating, type Chapter, type ChapterDetails } from "@paperback/types";

import {
  createDeterministicRandom,
  deriveDeterministicSeed,
} from "../../scripts/random-runtime.js";
import { parseComicChapter } from "../Atsumaru/parsers.js";
import { DIVA_SCANS_SITE } from "../DivaScans/site.js";
import { parseChapterDetails as madaraReader } from "../MadaraDex/parsers.js";
import { parseChapterDetails as mgekoReader } from "../Mgeko/parsers.js";
import { parseChapterDetails as qiReader } from "../QiManga/parsers.js";
import { parseChapterDetails as rinkoReader } from "../RinkoComics/parsers.js";
import { parseChapterDetails as rokariReader } from "../Rokari/parsers.js";
import { parseChapterDetails as thunderReader } from "../Thunderscans/parsers.js";
import { VALIR_SCANS_SITE } from "../ValirScans/site.js";
import { parseChapterDetails as vortexReader } from "../VortexScans/parsers.js";
import type { NovelDashSite } from "./noveldash-models.js";
import { parseNovelDashChapterDetails } from "./noveldash-parsers.js";
import { flightHtml } from "./noveldash-test-fixtures.js";

type Page = { url: string; order: number };
type Reader = (pages: Page[], chapter: Chapter) => ChapterDetails | Promise<ChapterDetails>;
const images = (pages: Page[]): string => pages.map(({ url }) => `<img src="${url}">`).join("");
const novelDashReader =
  (site: NovelDashSite): Reader =>
  (pages, chapter) =>
    parseNovelDashChapterDetails(
      flightHtml([
        `1c:${JSON.stringify({
          chapter: {
            id: chapter.chapterId,
            pages: pages.map(({ url, order }) => ({ imageUrl: url, pageNumber: order })),
          },
          isUnlocked: true,
        })}\n`,
      ]),
      chapter,
      site,
    );

const readers: Record<string, { base: string; ordered: boolean | "strict"; read: Reader }> = {
  Atsumaru: {
    base: "https://cdn.atsu.moe/static/pages/",
    ordered: true,
    read: (pages, chapter) =>
      parseComicChapter(
        {
          readChapter: {
            id: chapter.chapterId,
            pages: pages.map(({ url, order }) => ({ image: url, number: order })),
          },
        },
        chapter,
      ),
  },
  DivaScans: {
    base: "https://media.divascans.org/series/",
    ordered: true,
    read: novelDashReader(DIVA_SCANS_SITE),
  },
  ValirScans: {
    base: "https://media.valirscans.org/series/",
    ordered: true,
    read: novelDashReader(VALIR_SCANS_SITE),
  },
  MadaraDex: {
    base: "https://cdn.madaradex.org/series/",
    ordered: false,
    read: (pages, chapter) =>
      madaraReader(`<div class="reading-content">${images(pages)}</div>`, chapter),
  },
  Mgeko: {
    base: "https://imgsrv5.com/pages/",
    ordered: false,
    read: (pages, chapter) =>
      mgekoReader(`<section class="page-in">${images(pages)}</section>`, chapter),
  },
  QiManga: {
    base: "https://media.qimanga.com/series/",
    ordered: true,
    read: (pages, chapter) =>
      qiReader(
        {
          slug: chapter.chapterId,
          series: { slug: chapter.sourceManga.mangaId },
          number: chapter.chapNum,
          requiresPurchase: false,
          images: pages,
        },
        chapter,
      ),
  },
  RinkoComics: {
    base: "https://cdn.rinkocomics.com/wp-content/uploads/comics/property-series/40/",
    ordered: "strict",
    read: (pages) =>
      rinkoReader(
        `<html><head>
      <link rel="canonical" href="https://rinkocomics.com/chapter/property-series-chapter-40/">
      <link rel="alternate" type="application/json" href="https://rinkocomics.com/wp-json/wp/v2/chapters/22182">
      </head><body><h1 class="chapter-title">Property Series Chapter 40 <span class="chapter-tag free">Free</span></h1>
      <span class="status-message">Ready to read</span><span class="pages-count">${pages.length} pages</span>
      <div class="chapter-images-section"><div class="chapter-images-outer"><div class="images-flow">${pages.map(({ url, order }) => `<img class="chapter-image lazy-image" data-page="${order}" data-src="${url}">`).join("")}</div></div></div>
      </body></html>`,
        "property-series-chapter-40@22182",
        "property-series@13135",
        40,
        "Property Series Chapter 40",
      ),
  },
  Rokari: {
    base: "https://rokaricomics.com/wp-content/uploads/manga/series/",
    ordered: false,
    read: (pages, chapter) => rokariReader(`<main>${images(pages)}</main>`, chapter),
  },
  Thunderscans: {
    base: "https://cdn.example/pages/",
    ordered: false,
    read: (pages, chapter) =>
      thunderReader(
        `<script>ts_reader.run(${JSON.stringify({ sources: [{ source: "default", images: pages.map(({ url }) => url) }], defaultSource: "default", is_novel: false, protected: false })});</script>`,
        chapter,
      ),
  },
  VortexScans: {
    base: "https://cdn.example/pages/",
    ordered: true,
    read: (pages, chapter) =>
      vortexReader({ id: chapter.chapterId, isAccessible: true, pages }, chapter),
  },
};

void test("Monte Carlo reader adapters cover every released source", async () => {
  const directories = (await readdir(new URL("../", import.meta.url), { withFileTypes: true }))
    .filter(
      (entry) => entry.isDirectory() && entry.name !== "shared" && !entry.name.startsWith("."),
    )
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(Object.keys(readers).sort(), directories);
});

for (const [id, adapter] of Object.entries(readers)) {
  void test(`${id}: seeded reader page identity, ordering and empty-content rejection`, async () => {
    const chapter: Chapter = {
      chapterId: "101",
      chapNum: 1,
      langCode: "en",
      sourceManga: {
        mangaId: "simulation-series",
        mangaInfo: {
          primaryTitle: "Simulation",
          secondaryTitles: [],
          thumbnailUrl: `${adapter.base}cover.webp`,
          synopsis: "",
          contentRating: ContentRating.EVERYONE,
          contentType: "comic",
        },
      },
    };
    for (const seed of [0xc0ffee, 0x12345678, 0x5eed5eed, 0x7f4a7c15, 0xdeadbeef]) {
      const random = createDeterministicRandom(deriveDeterministicSeed(seed, id));
      for (let iteration = 0; iteration < 40; iteration += 1) {
        const count = random.integer(1, 40);
        const pages = Array.from({ length: count }, (_, index) => ({
          url: `${adapter.base}${seed}-${iteration}-${index + 1}.webp`,
          order: index + 1,
        }));
        const shuffled = random.sampleUnique(pages, count, (page) => page.url);
        const expected = (adapter.ordered ? pages : shuffled).map((page) => page.url);
        try {
          // Rinko requires contiguous DOM page numbers rather than repairing order.
          const result = await adapter.read(
            adapter.ordered === "strict" ? pages : shuffled,
            chapter,
          );
          if (adapter.ordered === "strict" && count > 1) {
            await assert.rejects(
              async () => adapter.read([...pages].reverse(), chapter),
              /invalid chapter image/,
            );
          }
          assert.ok("pages" in result);
          assert.deepEqual(result.pages, expected);
          assert.equal(new Set(result.pages).size, count);
          await assert.rejects(async () => adapter.read([], chapter));
        } catch (error) {
          throw new Error(`${id}: seed=${seed} iteration=${iteration} pages=${count}`, {
            cause: error,
          });
        }
      }
    }
  });
}
