import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ContentRating, SourceIntents } from "@paperback/types";

import config from "./pbconfig.js";

describe("Rokari Comics extension metadata", () => {
  it("exposes valid Paperback source metadata with a versioned alpha release", () => {
    assert.equal(config.name, "Rokari Comics");
    assert.match(config.version, /^\d+\.\d+\.\d+-alpha\.\d+$/);
    assert.equal(config.language, "en");
    assert.equal(config.icon, "icon.png");
    assert.equal(config.contentRating, ContentRating.ADULT);
  });

  it("pairs Cloudflare bypass with a settings form", () => {
    const capabilities = new Set(config.capabilities);
    assert.ok(capabilities.has(SourceIntents.CLOUDFLARE_BYPASS_PROVIDING));
    assert.ok(capabilities.has(SourceIntents.SETTINGS_FORM_PROVIDING));
  });
});
