import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { STATUS_OPTIONS, TYPE_OPTIONS, ThunderAdvancedSearchForm } from "./search.js";

describe("Thunder advanced search form", () => {
  it("offers every filter accepted by the live directory", () => {
    assert.deepEqual(
      STATUS_OPTIONS.map((option) => option.id),
      ["ongoing", "completed", "hiatus"],
    );
    assert.deepEqual(
      TYPE_OPTIONS.map((option) => option.id),
      ["manga", "manhwa", "manhua", "comic", "novel"],
    );
  });

  it("preserves existing single-value and genre selections", () => {
    const form = new ThunderAdvancedSearchForm(
      {
        title: "storm",
        metadata: {
          status: ["ongoing"],
          type: ["manhwa"],
          genres: { "10": "included", "20": "excluded" },
        },
      },
      [
        { id: "10", title: "Action" },
        { id: "20", title: "Adult" },
      ],
    );

    assert.deepEqual(form.getSearchQueryMetadata(), {
      status: ["ongoing"],
      type: ["manhwa"],
      genres: { "10": "included" },
    });
  });

  it("emits only active site-supported values after edits", async () => {
    const form = new ThunderAdvancedSearchForm({ title: "" }, [
      { id: "10", title: "Action" },
      { id: "20", title: "Adult" },
    ]);

    await form.handleStatusChange(["completed"]);
    await form.handleTypeChange(["novel"]);
    await form.handleGenresChange(["20", "10"]);

    assert.deepEqual(form.getSearchQueryMetadata(), {
      status: ["completed"],
      type: ["novel"],
      genres: { "10": "included", "20": "included" },
    });
  });

  it("does not share mutable query state with its caller", async () => {
    const genres: Record<string, "included" | "excluded"> = { "10": "included" };
    const form = new ThunderAdvancedSearchForm({ title: "", metadata: { genres } }, []);
    genres["20"] = "included";

    assert.deepEqual(form.getSearchQueryMetadata(), { genres: { "10": "included" } });
  });
});
