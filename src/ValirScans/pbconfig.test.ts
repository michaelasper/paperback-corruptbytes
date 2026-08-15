import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ContentRating } from "@paperback/types";

import config from "./pbconfig.js";

describe("Valir Scans extension metadata", () => {
  it("does not hide the non-adult catalog behind Paperback's adult-source filter", () => {
    assert.equal(config.contentRating, ContentRating.MATURE);
  });
});
