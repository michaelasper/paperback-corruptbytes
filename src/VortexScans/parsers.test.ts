import assert from "node:assert/strict";
import { test } from "node:test";

import { ContentRating, type SourceManga } from "@paperback/types";

import {
  chapterAccess,
  contentRatingForGenres,
  decodeMangaId,
  decodeMangaIdentifier,
  encodeMangaId,
  parseChapterDetails,
  parseChapterList,
  parseDate,
  parseMangaDetails,
  parseMangaList,
  safeUrl,
  stripHtml,
} from "./parsers.js";

const sourceManga: SourceManga = {
  mangaId: encodeMangaId("absolute-domination", 394),
  mangaInfo: {
    primaryTitle: "Absolute Domination",
    secondaryTitles: [],
    thumbnailUrl: "https://vortexscans.org/cover.png",
    synopsis: "",
    contentRating: ContentRating.EVERYONE,
  },
};

void test("manga IDs, URLs, dates, and HTML text are safe and deterministic", () => {
  const mangaId = encodeMangaId("hero's path/part two", 42);
  assert.equal(mangaId, "hero%27s%20path%2Fpart%20two@42");
  assert.deepEqual(decodeMangaIdentifier(mangaId), {
    slug: "hero's path/part two",
    numericId: 42,
  });
  assert.equal(decodeMangaId("hero%20path"), "hero path");
  assert.deepEqual(decodeMangaIdentifier("slug-only"), {
    slug: "slug-only",
  });

  assert.equal(
    safeUrl("/images/cover one.webp", "https://vortexscans.org"),
    "https://vortexscans.org/images/cover%20one.webp",
  );
  assert.equal(safeUrl("javascript:alert(1)"), "");
  assert.equal(safeUrl("not a URL"), "");
  assert.equal(parseDate("2026-08-08T12:53:37.949Z")?.toISOString(), "2026-08-08T12:53:37.949Z");
  assert.equal(parseDate("not-a-date"), undefined);
  assert.equal(
    stripHtml("<p>Hello &amp; <strong>world</strong>.</p><p>Next<br>line</p>"),
    "Hello & world.\n\nNext\nline",
  );
});

void test("URL parsing does not depend on browser globals unavailable in Paperback", () => {
  const browserURL = globalThis.URL;
  try {
    Object.assign(globalThis, { URL: undefined });

    assert.equal(
      safeUrl("https://storage.vortexscans.org/cover.webp"),
      "https://storage.vortexscans.org/cover.webp",
    );
    assert.equal(
      safeUrl("/images/cover.webp", "https://vortexscans.org"),
      "https://vortexscans.org/images/cover.webp",
    );
    assert.equal(
      parseMangaList({
        posts: [
          {
            id: 394,
            slug: "absolute-domination",
            postTitle: "Absolute Domination",
            featuredImage: "https://storage.vortexscans.org/cover.webp",
          },
        ],
      })[0]?.imageUrl,
      "https://storage.vortexscans.org/cover.webp",
    );
  } finally {
    Object.assign(globalThis, { URL: browserURL });
  }
});

void test("gore and violence genres are never advertised as suitable for everyone", () => {
  assert.equal(contentRatingForGenres(["Gore"]), ContentRating.MATURE);
  assert.equal(contentRatingForGenres(["violence"]), ContentRating.MATURE);
});

void test("manga lists and details preserve Vortex metadata", () => {
  const post = {
    id: 394,
    slug: "absolute-domination",
    postTitle: "Absolute Domination",
    postContent: "<p>A <em>great</em> story &amp; more.</p>",
    alternativeTitles: "Absolute Reign, 절대군림 | Absolute Dominion",
    author: " Writer ",
    artist: "Artist",
    seriesType: "MANHWA",
    seriesStatus: "ONGOING",
    featuredImage: "https://storage.vortexscans.org/cover.webp",
    genres: [
      { id: 1, name: "Action" },
      { id: 8, name: "Fantasy" },
    ],
    chapters: [
      { id: 101, number: 2, title: "", createdAt: "2026-08-02T00:00:00Z", isAccessible: true },
    ],
    averageRating: 9.25,
  };

  const [item] = parseMangaList({ posts: [post], totalCount: 1 });
  assert.ok(item);
  assert.equal(item.mangaId, "absolute-domination@394");
  assert.equal(item.title, "Absolute Domination");
  assert.equal(item.imageUrl, "https://storage.vortexscans.org/cover.webp");
  assert.equal(item.status, "Ongoing");
  assert.equal(item.contentType, "comic");
  assert.equal(item.contentRating, ContentRating.EVERYONE);
  assert.equal(item.publishDate?.toISOString(), "2026-08-02T00:00:00.000Z");

  const [lockedLatest] = parseMangaList({
    posts: [
      {
        ...post,
        chapters: [
          {
            id: 102,
            number: 3,
            createdAt: "2026-08-03T00:00:00Z",
            price: 100,
            isLocked: true,
            isAccessible: false,
          },
        ],
      },
    ],
  });
  assert.match(lockedLatest?.subtitle ?? "", /🔒 Chapter 3/);

  const details = parseMangaDetails({ post });
  assert.equal(details.mangaId, "absolute-domination@394");
  assert.equal(details.mangaInfo.primaryTitle, "Absolute Domination");
  assert.deepEqual(details.mangaInfo.secondaryTitles, [
    "Absolute Reign",
    "절대군림",
    "Absolute Dominion",
  ]);
  assert.equal(details.mangaInfo.status, "Ongoing");
  assert.equal(details.mangaInfo.contentType, "comic");
  assert.equal(details.mangaInfo.author, "Writer");
  assert.equal(details.mangaInfo.artist, "Artist");
  assert.equal(details.mangaInfo.synopsis, "A great story & more.");
  assert.deepEqual(details.mangaInfo.tagGroups?.[0]?.tags, [
    { id: "1", title: "Action" },
    { id: "8", title: "Fantasy" },
  ]);

  const [missingCover] = parseMangaList({
    posts: [{ id: 395, slug: "missing-cover", postTitle: "Missing Cover" }],
  });
  assert.equal(missingCover?.imageUrl, "https://vortexscans.org/favicon.ico");
  assert.equal(
    parseMangaDetails({ id: 395, slug: "missing-cover", postTitle: "Missing Cover" }).mangaInfo
      .thumbnailUrl,
    "https://vortexscans.org/favicon.ico",
  );
});

void test("full chapter lists expose lock semantics and sort/index deterministically", () => {
  const chapters = [
    {
      id: 20,
      slug: "chapter-10",
      number: "10",
      title: "Ten",
      createdAt: "2026-01-03T00:00:00Z",
      price: 50,
      isLocked: true,
      isTimeLocked: false,
      isPermanentlyLocked: true,
      chapterPurchased: false,
      isPurchased: false,
      hasPurchased: false,
      isAccessible: false,
    },
    {
      id: 18,
      slug: "chapter-2",
      number: 2,
      title: "Two",
      createdAt: "2026-01-01T00:00:00Z",
      price: 0,
      isLocked: false,
      isAccessible: true,
    },
    {
      id: 19,
      slug: "chapter-2-b",
      number: 2,
      title: "Two bonus",
      createdAt: "2026-01-02T00:00:00Z",
      price: 75,
      isLocked: true,
      isTimeLocked: true,
      chapterPurchased: true,
      isPurchased: true,
      hasPurchased: true,
      isAccessible: false,
    },
    {
      id: 21,
      slug: "chapter-1-5",
      number: "Chapter 1.5",
      title: "One point five",
      createdAt: "2026-01-01T12:00:00Z",
      unlockAt: "2999-01-01T00:00:00Z",
      price: 10,
      isAccessible: false,
    },
  ];

  const parsed = parseChapterList({ post: { chapters } }, sourceManga, { showLocked: true });
  assert.deepEqual(
    parsed.map((chapter) => chapter.chapNum),
    [1.5, 2, 2, 10],
  );
  assert.deepEqual(
    parsed.map((chapter) => chapter.sortingIndex),
    [0, 1, 2, 3],
  );
  assert.deepEqual(
    parsed.map((chapter) => chapter.chapterId),
    ["21", "18", "19", "20"],
  );
  assert.equal(parsed[2]?.additionalInfo?.isLocked, "true");
  assert.equal(parsed[2]?.additionalInfo?.isTimeLocked, "true");
  assert.equal(parsed[2]?.additionalInfo?.price, "75");
  assert.equal(parsed[2]?.additionalInfo?.chapterPurchased, "true");
  assert.equal(parsed[2]?.additionalInfo?.isPurchased, "true");
  assert.equal(parsed[2]?.additionalInfo?.hasPurchased, "true");
  assert.equal(parsed[2]?.additionalInfo?.isAccessible, "true");
  assert.equal(parsed[3]?.additionalInfo?.isPermanentlyLocked, "true");
  assert.match(parsed[3]?.title ?? "", /^🔒 /);
  assert.doesNotMatch(parsed[2]?.title ?? "", /^🔒 /);
  assert.equal(parsed[0]?.publishDate?.toISOString(), "2026-01-01T12:00:00.000Z");

  const unlockedOnly = parseChapterList(chapters, sourceManga, { showLocked: false });
  assert.deepEqual(
    unlockedOnly.map((chapter) => chapter.chapterId),
    ["18", "19"],
  );
  assert.equal(parseChapterList(chapters, sourceManga, false).length, unlockedOnly.length);
});

void test("purchased chapters remain readable even when price/lock flags are set", () => {
  const raw = {
    id: 19,
    number: 2,
    price: 75,
    isLocked: true,
    isPermanentlyLocked: true,
    chapterPurchased: true,
    isAccessible: false,
    content: "<p>Purchased text</p>",
  };
  const access = chapterAccess(raw);
  assert.equal(access.isLocked, true);
  assert.equal(access.isTimeLocked, false);
  assert.equal(access.price, 75);
  assert.equal(access.isPermanentlyLocked, true);
  assert.equal(access.chapterPurchased, true);
  assert.equal(access.isPurchased, true);
  assert.equal(access.hasPurchased, true);
  assert.equal(access.isAccessible, true);

  const conflictingPurchaseFlags = {
    ...raw,
    id: 20,
    chapterPurchased: false,
    isPurchased: false,
    hasPurchased: true,
  };
  const conflictingAccess = chapterAccess(conflictingPurchaseFlags);
  assert.equal(conflictingAccess.chapterPurchased, true);
  assert.equal(conflictingAccess.isAccessible, true);
  assert.deepEqual(
    parseChapterList([conflictingPurchaseFlags], sourceManga, { showLocked: false }).map(
      (chapter) => chapter.chapterId,
    ),
    ["20"],
  );

  const details = parseChapterDetails(raw, {
    chapterId: "19",
    sourceManga,
    chapNum: 2,
    langCode: "en",
  });
  assert.equal(details.type, "html");
  if (details.type === "html") assert.match(details.html, /Purchased text/);

  const explicitlyAccessible = parseChapterDetails(
    {
      id: 20,
      price: 75,
      isLocked: true,
      isPermanentlyLocked: true,
      isAccessible: true,
      content: "<p>Membership text</p>",
    },
    { chapterId: "20", sourceManga, chapNum: 2, langCode: "en" },
  );
  assert.equal(explicitlyAccessible.type, "html");
  assert.throws(
    () =>
      parseChapterDetails(
        { id: 21, price: 10, isLocked: true, isAccessible: false, content: "<p>Locked</p>" },
        {
          chapterId: "21",
          sourceManga,
          chapNum: 2,
          langCode: "en",
          additionalInfo: { price: "10", isAccessible: "false" },
        },
      ),
    /locked.*unlock.*Vortex/i,
  );
  assert.throws(
    () =>
      parseChapterDetails(
        { id: 22, isAccessible: true, isPurchased: true, images: [] },
        { chapterId: "22", sourceManga, chapNum: 2, langCode: "en" },
      ),
    /purchased.*no readable content/i,
  );
});

void test("chapter details parse image pages and novel HTML without Application", () => {
  const imageDetails = parseChapterDetails(
    {
      id: 101,
      isAccessible: true,
      pages: [
        { order: 2, url: "https://cdn.example/2.webp" },
        { order: 1, url: "https://cdn.example/1.webp" },
      ],
    },
    { chapterId: "101", sourceManga, chapNum: 1, langCode: "en" },
  );
  assert.deepEqual(imageDetails, {
    id: "101",
    mangaId: sourceManga.mangaId,
    pages: ["https://cdn.example/1.webp", "https://cdn.example/2.webp"],
  });

  const novelDetails = parseChapterDetails(
    { id: 102, isAccessible: true, content: "<h1>Chapter 1</h1><p>Hello &amp; goodbye.</p>" },
    { chapterId: "102", sourceManga, chapNum: 1, langCode: "en" },
  );
  assert.equal(novelDetails.type, "html");
  if (novelDetails.type === "html") {
    assert.match(novelDetails.html, /<h1>Chapter 1<\/h1>/);
    assert.match(novelDetails.html, /Hello &amp; goodbye\./);
    assert.match(novelDetails.html, /^<html[^>]*><head><\/head><body>/);
  }

  const sanitizedNovel = parseChapterDetails(
    {
      id: 104,
      isAccessible: true,
      content:
        '<p style="position:fixed" onclick="steal()">Safe text</p>' +
        '<a href="javascript:steal()">Unsafe link</a>' +
        '<a href="/series/safe">Safe link</a>' +
        '<img src="data:text/html,unsafe" onerror="steal()">' +
        '<svg><a href="https://safe.example"><animate attributeName="href" values="javascript:steal()" /></a></svg>',
    },
    { chapterId: "104", sourceManga, chapNum: 1, langCode: "en" },
  );
  assert.equal(sanitizedNovel.type, "html");
  if (sanitizedNovel.type === "html") {
    assert.doesNotMatch(
      sanitizedNovel.html,
      /javascript:|data:text|onerror|onclick|style=|<svg|<animate/i,
    );
    assert.match(sanitizedNovel.html, /href="https:\/\/vortexscans\.org\/series\/safe"/);
  }

  const htmlPage = `
    <html><body>
      <img src="https://vortexscans.org/logo.png">
      <div class="comic-images-wrapper">
        <img data-reader-page-image data-reader-index="1" src="https://cdn.example/page-2.webp">
        <img data-reader-page-image data-reader-index="0" src="https://cdn.example/page-1.webp">
      </div>
    </body></html>`;
  const pageDetails = parseChapterDetails(htmlPage, {
    chapterId: "103",
    sourceManga,
    chapNum: 1,
    langCode: "en",
  });
  assert.deepEqual(pageDetails, {
    id: "103",
    mangaId: sourceManga.mangaId,
    pages: ["https://cdn.example/page-1.webp", "https://cdn.example/page-2.webp"],
  });
});
