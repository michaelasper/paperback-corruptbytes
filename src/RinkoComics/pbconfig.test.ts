import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import { ContentRating, SourceIntents } from "@paperback/types";

import config from "./pbconfig.js";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

describe("Rinko Comics metadata", () => {
  it("declares only implemented public capabilities", () => {
    assert.equal(config.name, "Rinko Comics");
    assert.equal(config.version, "1.0.0-alpha.1");
    assert.equal(config.language, "en");
    assert.equal(config.contentRating, ContentRating.MATURE);
    assert.deepEqual(config.capabilities, [
      SourceIntents.CHAPTER_PROVIDING,
      SourceIntents.DISCOVER_SECTION_PROVIDING,
      SourceIntents.SEARCH_RESULT_PROVIDING,
    ]);
    const capabilities: readonly SourceIntents[] = config.capabilities;
    assert.equal(capabilities.includes(SourceIntents.CLOUDFLARE_BYPASS_PROVIDING), false);
    assert.equal(capabilities.includes(SourceIntents.SETTINGS_FORM_PROVIDING), false);
  });

  it("ships an official square PNG icon", async () => {
    const icon = await readFile(new URL("./static/icon.png", import.meta.url));
    assert.deepEqual(icon.subarray(0, PNG_SIGNATURE.length), PNG_SIGNATURE);
    assert.ok(icon.length > 1_000);
    assert.equal(icon.readUInt32BE(16), 192);
    assert.equal(icon.readUInt32BE(20), 192);
  });
});
