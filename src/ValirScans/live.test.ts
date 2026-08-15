import { after, describe, it } from "node:test";

import {
  assertNovelDashCatalogContract,
  assertNovelDashCompleteHistory,
  assertNovelDashMetadataContract,
  assertNovelDashReaderContract,
  installNovelDashLiveApplication,
} from "../shared/test-fixtures/noveldash-live.js";
import { VALIR_SCANS_SITE } from "./site.js";

const live = process.env.VALIR_LIVE_TESTS === "1";
const restoreApplication = installNovelDashLiveApplication(live);

after(restoreApplication);

describe("Valir Scans live public contract", { skip: !live }, () => {
  it("serves its anonymous catalog, account state, and full genre taxonomy", async () => {
    await assertNovelDashCatalogContract(VALIR_SCANS_SITE);
  });

  it("loads every chapter page and preserves the working route slug", async () => {
    await assertNovelDashCompleteHistory(VALIR_SCANS_SITE, {
      kind: "novel",
      slug: "the-forgotten-field",
      internalSlug: "the-forgotten-field-novel",
      title: "The Forgotten Field",
      minimumChapters: 200,
      readableAfterChapter: 100,
    });
  });

  it("serves real covers and safe multi-word metadata IDs", async () => {
    await assertNovelDashMetadataContract(VALIR_SCANS_SITE, {
      kind: "comic",
      slug: "insos-law",
      title: "Inso’s Law",
      expectedTags: [
        { id: "school-life", title: "School Life" },
        { id: "slice-of-life", title: "Slice of Life" },
      ],
    });
  });

  it("renders an anonymously accessible comic chapter", async () => {
    await assertNovelDashReaderContract(VALIR_SCANS_SITE, {
      kind: "comic",
      slug: "the-guidebook-for-villainesses",
      title: "The Guidebook for Villainesses",
    });
  });
});
