import { after, describe, it } from "node:test";

import {
  assertNovelDashCatalogContract,
  assertNovelDashCompleteHistory,
  assertNovelDashReaderContract,
  installNovelDashLiveApplication,
} from "../shared/test-fixtures/noveldash-live.js";
import { DIVA_SCANS_SITE } from "./site.js";

const live = process.env.DIVA_LIVE_TESTS === "1";
const restoreApplication = installNovelDashLiveApplication(live);

after(restoreApplication);

describe("Diva Scans live public contract", { skip: !live }, () => {
  it("serves its anonymous catalog, account state, and full genre taxonomy", async () => {
    await assertNovelDashCatalogContract(DIVA_SCANS_SITE);
  });

  it("loads every chapter page and rejects explicitly locked reader payloads", async () => {
    await assertNovelDashCompleteHistory(DIVA_SCANS_SITE, {
      kind: "comic",
      slug: "ill-give-you-the-most-rotten-thing",
      title: "I'll Give You the Most Rotten Thing",
      minimumChapters: 101,
      readableAfterChapter: 100,
    });
  });

  it("renders an anonymously accessible novel chapter as sanitized HTML", async () => {
    await assertNovelDashReaderContract(DIVA_SCANS_SITE, {
      kind: "novel",
      slug: "to-think-my-next-door-nerd-is-the-tower-master",
      title: "To Think My Next-Door Nerd is the Tower Master",
    });
  });
});
