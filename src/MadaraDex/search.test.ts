import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { SearchQuery, Tag } from "@paperback/types";

import type { MadaraSearchMetadata } from "./models.js";
import { MadaraDexAdvancedSearchForm } from "./search.js";

const originalApplication = globalThis.Application;

beforeEach(() => {
  Object.assign(globalThis, {
    Application: { Selector: (_form: unknown, method: string) => method },
  });
});

afterEach(() => Object.assign(globalThis, { Application: originalApplication }));

describe("MadaraDex advanced search", () => {
  const genres: Tag[] = [
    { id: "action", title: "Action" },
    { id: "martial-arts", title: "Martial Arts" },
  ];
  const statuses: Tag[] = [
    { id: "on-going", title: "Ongoing" },
    { id: "end", title: "Completed" },
  ];

  it("round-trips every live WordPress filter", async () => {
    const metadata: MadaraSearchMetadata = {
      genres: ["action", "martial-arts"],
      genreCondition: "and",
      author: "Yonoki",
      artist: "Studio A",
      release: "2026",
      adult: "none",
      status: ["on-going"],
    };
    const form = new MadaraDexAdvancedSearchForm({ title: "", metadata }, { genres, statuses });
    assert.deepEqual(form.getSearchQueryMetadata(), metadata);
    assert.equal(form.getSections().length, 4);
  });

  it("normalizes whitespace, limits release to a year, and omits defaults", async () => {
    const query: SearchQuery<MadaraSearchMetadata> = { title: "" };
    const form = new MadaraDexAdvancedSearchForm(query, { genres, statuses });
    await form.handleAuthorChange("  A.   Writer ");
    await form.handleArtistChange("   ");
    await form.handleReleaseChange("released in 2026");
    await form.handleAdultChange(["all"]);
    await form.handleGenreConditionChange(["or"]);

    assert.deepEqual(form.getSearchQueryMetadata(), {
      author: "A. Writer",
      release: "2026",
    });
  });
});
