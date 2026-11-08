import assert from "node:assert/strict";
import { createContext, runInContext } from "node:vm";

const canonicalKey = "atsumaruCanonicalMangaId";
const chaptersUrl = (id) => `https://atsu.moe/api/manga/allChapters?mangaId=${id}`;
const readerUrl = "https://atsu.moe/api/read/chapter?mangaId=fixture-current&chapterId=fixture-2";
const chapterBody = {
  chapters: [
    { id: "fixture-1", number: 1, index: 0, createdAt: 1700000000000 },
    { id: "fixture-2", number: 1, index: 1, createdAt: 1700000001000 },
  ].map((chapter) => ({ ...chapter, scanlationMangaId: "fixture-team" })),
};

const manga = (team) => ({
  mangaId: "fixture-library",
  mangaInfo: {
    primaryTitle: "Synthetic association fixture",
    secondaryTitles: ["Synthetic alternate title"],
    thumbnailUrl: "https://cdn.atsu.moe/static/posters/fixture.webp",
    synopsis: "",
    contentRating: "SAFE",
    contentType: "comic",
    additionalInfo: {
      [canonicalKey]: "fixture-current",
      atsumaruScanlators: JSON.stringify({ scanlators: [{ id: "fixture-team", name: team }] }),
      format: "comic",
    },
  },
});

export async function verifyAtsumaruAssociations(code) {
  let alternates = true;
  const requests = [];
  const context = createContext({
    Application: {
      getState: (key) => (key === "atsumaru_show_alternate_translations" ? alternates : undefined),
      getSecureState: () => undefined,
      setState: () => {},
      setSecureState: () => {},
      Selector: (owner, method) => owner[method].bind(owner),
      registerInterceptor: () => {},
      arrayBufferToUTF8String: (buffer) => new TextDecoder().decode(buffer),
      scheduleRequest: async (request) => {
        requests.push(request.url);
        const url = new URL(request.url);
        let body;
        if (request.url === chaptersUrl("fixture-current")) {
          body = chapterBody;
        } else if (
          [chaptersUrl("fixture-stale"), chaptersUrl("fixture-library")].includes(request.url)
        ) {
          body = { chapters: [] };
        } else if (
          url.origin === "https://atsu.moe" &&
          url.pathname === "/collections/manga/documents/search"
        ) {
          assert.equal(url.searchParams.get("q"), "Synthetic association fixture");
          body = {
            found: 1,
            page: 1,
            hits: [
              {
                document: {
                  id: "fixture-current",
                  title: "Synthetic association fixture",
                  isAdult: false,
                },
              },
            ],
          };
        } else if (request.url === readerUrl) {
          body = {
            readChapter: {
              id: "fixture-2",
              scanlationMangaId: "fixture-team",
              pages: [{ number: 0, image: "/static/pages/fixture/1.webp" }],
            },
          };
        } else {
          assert.fail(`Unexpected Atsumaru fixture request ${request.url}`);
        }
        return [
          {
            status: 200,
            url: request.url,
            headers: { "content-type": "application/json" },
            cookies: [],
          },
          runInContext("Uint8Array", context).from(new TextEncoder().encode(JSON.stringify(body)))
            .buffer,
        ];
      },
    },
  });
  runInContext(code, context, { timeout: 5_000, filename: "Atsumaru/index.js" });
  const source = context.source.Atsumaru;
  await source.initialise();

  const restored = JSON.parse(JSON.stringify(manga("Restored team")));
  const frozen = manga("Frozen team");
  Object.freeze(frozen.mangaInfo.additionalInfo);
  Object.freeze(frozen.mangaInfo.secondaryTitles);
  Object.freeze(frozen.mangaInfo);
  Object.freeze(frozen);
  const bridgeInfo = manga("Bridge team").mangaInfo;
  let formatReads = 0;
  Object.defineProperty(bridgeInfo.additionalInfo, "format", {
    enumerable: true,
    get() {
      formatReads += 1;
      return "comic";
    },
  });
  class BridgeManga {
    get mangaId() {
      return "fixture-library";
    }
    get mangaInfo() {
      return bridgeInfo;
    }
  }
  const bridge = new BridgeManga();
  for (const [input, team] of [
    [restored, "Restored team"],
    [frozen, "Frozen team"],
    [bridge, "Bridge team"],
  ]) {
    const before = JSON.stringify(input);
    const info = input.mangaInfo;
    const metadata = info.additionalInfo;
    const infoDescriptors = Object.getOwnPropertyDescriptors(info);
    const metadataDescriptors = Object.getOwnPropertyDescriptors(metadata);
    const titles = [...info.secondaryTitles];
    for (const enabled of [true, false]) {
      alternates = enabled;
      const chapters = await source.getChapters(input, new Date(2_000_000_000_000));
      assert.equal(formatReads, 0, "chapter enumeration read an unrelated format getter");
      assert.deepEqual(
        Array.from(chapters, ({ chapterId }) => chapterId),
        enabled ? ["fixture-1", "fixture-2"] : ["fixture-2"],
      );
      for (const chapter of chapters) {
        assert.equal(
          chapter.sourceManga,
          input,
          "Chapter.sourceManga must retain the caller's association",
        );
        assert.equal(chapter.sourceManga.mangaInfo, info);
        assert.equal(chapter.sourceManga.mangaInfo.additionalInfo, metadata);
        assert.equal(chapter.version, team);
        assert.equal(chapter.additionalInfo[canonicalKey], "fixture-current");
      }
      assert.equal(JSON.stringify(input), before, "chapter enumeration mutated the caller");
      assert.deepEqual(Object.getOwnPropertyDescriptors(info), infoDescriptors);
      assert.deepEqual(Object.getOwnPropertyDescriptors(metadata), metadataDescriptors);
      assert.deepEqual(info.secondaryTitles, titles);
    }
  }
  assert.deepEqual(requests, [chaptersUrl("fixture-current")]);

  const recovered = manga("Recovered team");
  recovered.mangaInfo.additionalInfo[canonicalKey] = "fixture-stale";
  const before = JSON.stringify(recovered);
  const start = requests.length;
  const chapters = await source.getChapters(recovered);
  assert.equal(chapters.length, 1);
  assert.equal(chapters[0].sourceManga, recovered);
  assert.equal(chapters[0].version, "Recovered team");
  assert.equal(chapters[0].additionalInfo[canonicalKey], "fixture-current");
  assert.equal(JSON.stringify(recovered), before);
  const details = await source.getChapterDetails(chapters[0]);
  assert.equal(details.id, "fixture-2");
  assert.equal(details.mangaId, "fixture-library");
  assert.deepEqual(Array.from(details.pages), ["https://cdn.atsu.moe/static/pages/fixture/1.webp"]);
  assert.equal(requests[start], chaptersUrl("fixture-stale"));
  assert.equal(new URL(requests[start + 1]).pathname, "/collections/manga/documents/search");
  assert.equal(requests[start + 2], chaptersUrl("fixture-library"));
  assert.equal(requests[start + 3], readerUrl);
  assert.equal(requests.length, start + 4);
}
