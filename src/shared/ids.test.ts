import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { decodePaperbackIdComponent, encodePaperbackIdComponent, validateOpaqueId } from "./ids.js";

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

  it("validates bounded opaque IDs consistently at parse and request boundaries", () => {
    assert.equal(validateOpaqueId("Series.v2~draft"), "Series.v2~draft");

    for (const value of [
      "",
      ".",
      "..",
      " leading",
      "trailing ",
      "line\nbreak",
      "bell\u0007",
      "delete\u007f",
      "path/part",
      "query?part",
      "hash#part",
      "back\\slash",
      "x".repeat(257),
    ]) {
      assert.equal(validateOpaqueId(value), undefined, JSON.stringify(value));
    }
  });

  it("rejects malformed Unicode that cannot be encoded as a URL component", () => {
    assert.equal(validateOpaqueId("chapter-\ud800"), undefined);
    assert.equal(validateOpaqueId("chapter-\udfff"), undefined);
    assert.equal(validateOpaqueId(`chapter-${String.fromCodePoint(0xfdd0)}`), undefined);
    assert.equal(validateOpaqueId(`chapter-${String.fromCodePoint(0xffff)}`), undefined);
    assert.equal(validateOpaqueId(`chapter-${String.fromCodePoint(0x10ffff)}`), undefined);
    assert.equal(validateOpaqueId("chapter-😀"), "chapter-😀");
  });
});
