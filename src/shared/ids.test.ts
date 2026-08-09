import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { decodePaperbackIdComponent, encodePaperbackIdComponent } from "./ids.js";

describe("Paperback source IDs", () => {
  it("preserves existing safe slugs and escapes the narrower Paperback alphabet", () => {
    assert.equal(encodePaperbackIdComponent("existing-safe_slug.2"), "existing-safe_slug.2");
    assert.equal(encodePaperbackIdComponent("dark-~-mage"), "dark-%7E-mage");
    assert.equal(
      encodePaperbackIdComponent("hero's path/part (2)"),
      "hero%27s%20path%2Fpart%20%282%29",
    );
    assert.equal(encodePaperbackIdComponent("魔王"), "%E9%AD%94%E7%8E%8B");
  });

  it("round-trips encoded IDs and tolerates malformed legacy percent escapes", () => {
    const raw = "dark-~-mage/魔王";
    assert.equal(decodePaperbackIdComponent(encodePaperbackIdComponent(raw)), raw);
    assert.equal(decodePaperbackIdComponent("legacy%broken"), "legacy%broken");
  });
});
