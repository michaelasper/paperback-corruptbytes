import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ContentRating } from "@paperback/types";

import config from "./pbconfig.js";

describe("Temple Scan extension metadata", () => {
  it("exposes valid Paperback source metadata with a versioned alpha release", () => {
    assert.equal(config.name, "Temple Scan");
    assert.match(config.version, /^\d+\.\d+\.\d+-alpha\.\d+$/);
    assert.equal(config.language, "en");
    assert.equal(config.icon, "icon.png");
    assert.equal(config.contentRating, ContentRating.ADULT);
  });
});
