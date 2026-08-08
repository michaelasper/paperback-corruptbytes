import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { STATUS_OPTIONS, TYPE_OPTIONS, VortexAdvancedSearchForm } from "./search.js";

describe("Vortex advanced search form", () => {
  it("offers every series type and status accepted by the live API", () => {
    assert.ok(TYPE_OPTIONS.some((option) => option.id === "NOVEL"));
    assert.ok(STATUS_OPTIONS.some((option) => option.id === "HIATUS"));
  });

  it("preserves an existing search selection", () => {
    const form = new VortexAdvancedSearchForm(
      {
        title: "hero",
        metadata: {
          status: ["ONGOING"],
          type: ["MANHWA"],
          direction: ["asc"],
          genres: { "3": "included", "9": "excluded" },
        },
      },
      [
        { id: "3", title: "Action" },
        { id: "9", title: "Mature" },
      ],
    );

    assert.deepEqual(form.getSearchQueryMetadata(), {
      status: ["ONGOING"],
      type: ["MANHWA"],
      direction: ["asc"],
      genres: { "3": "included", "9": "excluded" },
    });
  });

  it("emits only selected filters after edits", async () => {
    const form = new VortexAdvancedSearchForm({ title: "" }, []);

    await form.handleStatusChange(["COMPLETED"]);
    await form.handleTypeChange(["MANGA"]);
    await form.handleDirectionChange(["desc"]);
    await form.handleGenresChange({ "7": "included" });

    assert.deepEqual(form.getSearchQueryMetadata(), {
      status: ["COMPLETED"],
      type: ["MANGA"],
      direction: ["desc"],
      genres: { "7": "included" },
    });
  });

  it("does not share mutable genre state with the incoming query", async () => {
    const genres: Record<string, "included" | "excluded"> = { "1": "included" };
    const form = new VortexAdvancedSearchForm({ title: "", metadata: { genres } }, []);

    genres["2"] = "excluded";

    assert.deepEqual(form.getSearchQueryMetadata(), { genres: { "1": "included" } });
  });
});
