import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ContentRating } from "@paperback/types";

import config from "./pbconfig.js";

describe("Diva Scans extension metadata", () => {
  it("keeps the explicit catalog behind Paperback's adult-source filter", () => {
    assert.equal(config.contentRating, ContentRating.ADULT);
  });
});
