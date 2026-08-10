import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ContentRating, SourceIntents } from "@paperback/types";

import config from "./pbconfig.js";

describe("Atsumaru extension metadata", () => {
  it("advertises the complete anonymous reading surface", () => {
    assert.equal(config.name, "Atsumaru");
    assert.equal(config.version, "1.0.0-alpha.5");
    assert.equal(config.contentRating, ContentRating.ADULT);
    assert.deepEqual(config.capabilities, [
      SourceIntents.CHAPTER_PROVIDING,
      SourceIntents.CLOUDFLARE_BYPASS_PROVIDING,
      SourceIntents.DISCOVER_SECTION_PROVIDING,
      SourceIntents.SEARCH_RESULT_PROVIDING,
      SourceIntents.SETTINGS_FORM_PROVIDING,
    ]);
    assert.match(config.description, /comics/i);
    assert.match(config.description, /novels/i);
    assert.match(config.description, /anonymous/i);
    assert.equal(config.developers[0]?.name, "corruptbytes");
  });
});
