import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ContentRating, SourceIntents } from "@paperback/types";

import config from "./pbconfig.js";

describe("Qi Manga extension metadata", () => {
  it("advertises the complete account-aware reading surface behind the adult catalog filter", () => {
    assert.equal(config.contentRating, ContentRating.ADULT);
    assert.deepEqual(config.capabilities, [
      SourceIntents.CHAPTER_PROVIDING,
      SourceIntents.CLOUDFLARE_BYPASS_PROVIDING,
      SourceIntents.DISCOVER_SECTION_PROVIDING,
      SourceIntents.SEARCH_RESULT_PROVIDING,
      SourceIntents.SETTINGS_FORM_PROVIDING,
    ]);
    assert.equal(config.version, "1.0.0-alpha.3");
  });
});
