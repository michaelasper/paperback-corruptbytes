import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildNovelDashCatalogUrl,
  buildNovelDashChapterUrl,
  buildNovelDashSeriesUrl,
  decodeNovelDashMangaId,
  encodeNovelDashMangaId,
  parseNovelDashSeriesUrl,
} from "./noveldash-network.js";
import { NOVELDASH_TEST_SITE } from "./noveldash-test-fixtures.js";

describe("NovelDash network contract", () => {
  it("builds deterministic catalog filters and bounds pagination", () => {
    const url = buildNovelDashCatalogUrl(
      NOVELDASH_TEST_SITE,
      {
        title: "  Dragon   ‘King’  ",
        metadata: {
          genres: { romance: "included", adult: "excluded", ignored: "included" },
          statuses: ["ONGOING", "COMPLETED", "ONGOING"],
          types: ["WEB_NOVEL", "MANHWA"],
          origins: ["KOREAN"],
          chapterRangeEnabled: true,
          minimumChapters: -5,
          maximumChapters: 200_000,
          onSale: true,
        },
      },
      { id: "longest", label: "Most chapters" },
      -2,
      500,
    );

    assert.equal(
      url,
      "https://fixture.example/api/series?page=1&limit=100&contentMode=all&q=Dragon%20%27King%27&genre=ignored%2Cromance&exgenre=adult&type=MANHWA%2CWEB_NOVEL&status=COMPLETED%2CONGOING&origin=KOREAN&sort=longest&sale=true&ch_min=0&ch_max=100000",
    );
  });

  it("keeps the public route slug distinct from the internal slug", () => {
    const mangaId = encodeNovelDashMangaId("novel", "the-forgotten-field");
    assert.deepEqual(decodeNovelDashMangaId(mangaId), {
      kind: "novel",
      slug: "the-forgotten-field",
    });
    assert.equal(
      buildNovelDashSeriesUrl(NOVELDASH_TEST_SITE, mangaId, 2),
      "https://fixture.example/series/novel/the-forgotten-field?page=2",
    );
    assert.equal(
      buildNovelDashChapterUrl(NOVELDASH_TEST_SITE, mangaId, "110.5"),
      "https://fixture.example/series/novel/the-forgotten-field/chapter/110.5",
    );
  });

  it("resolves series and chapter URLs without trusting foreign or credentialed origins", () => {
    const expected = encodeNovelDashMangaId("comic", "fixture-title");
    assert.equal(
      parseNovelDashSeriesUrl(
        NOVELDASH_TEST_SITE,
        "https://fixture.example/series/comic/fixture-title/chapter/4?ref=test",
      ),
      expected,
    );
    assert.equal(
      parseNovelDashSeriesUrl(
        NOVELDASH_TEST_SITE,
        "https://reader:secret@fixture.example/series/comic/fixture-title",
      ),
      undefined,
    );
    assert.equal(
      parseNovelDashSeriesUrl(
        NOVELDASH_TEST_SITE,
        "https://notfixture.example/series/comic/fixture-title",
      ),
      undefined,
    );
  });

  it("rejects malformed series and chapter identifiers", () => {
    assert.throws(() => encodeNovelDashMangaId("comic", "../escape"), /slug is invalid/i);
    assert.throws(
      () =>
        buildNovelDashChapterUrl(NOVELDASH_TEST_SITE, encodeNovelDashMangaId("comic", "ok"), "1/2"),
      /number is invalid/i,
    );
  });
});
