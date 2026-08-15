import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import {
  NOVELDASH_ORIGIN_OPTIONS,
  NOVELDASH_STATUS_OPTIONS,
  NOVELDASH_TYPE_OPTIONS,
  NovelDashAdvancedSearchForm,
} from "./noveldash-search.js";

const originalApplication = globalThis.Application;

before(() => {
  Object.assign(globalThis, {
    Application: {
      Selector: () => "selector",
      formDidChange: () => undefined,
    },
  });
});

after(() => {
  Object.assign(globalThis, { Application: originalApplication });
});

describe("NovelDash advanced search", () => {
  it("advertises the live format, status, and origin values", () => {
    assert.ok(NOVELDASH_TYPE_OPTIONS.some((option) => option.id === "WEB_NOVEL"));
    assert.ok(NOVELDASH_STATUS_OPTIONS.some((option) => option.id === "DISCONTINUED"));
    assert.deepEqual(
      NOVELDASH_ORIGIN_OPTIONS.map((option) => option.id),
      ["KOREAN", "JAPANESE", "CHINESE", "OTHER"],
    );
  });

  it("normalizes chapter bounds and emits only active filters", async () => {
    const form = new NovelDashAdvancedSearchForm(
      {
        title: "fixture",
        metadata: {
          genres: { action: "included", adult: "excluded" },
          types: ["MANHWA"],
          statuses: ["ONGOING"],
          origins: ["KOREAN"],
          chapterRangeEnabled: true,
          minimumChapters: 500,
          maximumChapters: 100,
        },
      },
      [
        { id: "action", title: "Action" },
        { id: "adult", title: "Adult" },
      ],
    );
    await form.handleOnSaleChange(true);

    assert.deepEqual(form.getSearchQueryMetadata(), {
      genres: { action: "included", adult: "excluded" },
      statuses: ["ONGOING"],
      types: ["MANHWA"],
      origins: ["KOREAN"],
      chapterRangeEnabled: true,
      minimumChapters: 100,
      maximumChapters: 500,
      onSale: true,
    });
  });

  it("does not share mutable filter state with the caller", async () => {
    const genres: Record<string, "included" | "excluded"> = { action: "included" };
    const types = ["NOVEL"];
    const form = new NovelDashAdvancedSearchForm({ title: "", metadata: { genres, types } }, []);
    genres.adult = "excluded";
    types.push("MANHWA");

    assert.deepEqual(form.getSearchQueryMetadata(), {
      genres: { action: "included" },
      types: ["NOVEL"],
    });
  });
});
