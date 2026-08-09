import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { SearchQuery, Tag } from "@paperback/types";

import type { MgekoSearchMetadata } from "./models.js";
import { MgekoAdvancedSearchForm } from "./search.js";

const originalApplication = globalThis.Application;

beforeEach(() => {
  Object.assign(globalThis, {
    Application: {
      Selector: (_form: unknown, method: string) => method,
    },
  });
});

afterEach(() => Object.assign(globalThis, { Application: originalApplication }));

describe("Mgeko advanced search", () => {
  const genres: Tag[] = [
    { id: "Action", title: "Action" },
    { id: "Mature", title: "Mature" },
  ];

  it("round-trips every live filter and keeps maximum chapter changes separate", async () => {
    const query: SearchQuery<MgekoSearchMetadata> = {
      title: "",
      metadata: {
        genres: { Action: "included", Mature: "excluded" },
        status: ["ongoing"],
        type: ["manhwa"],
        tags: "regression,sword-master",
        setChapterCount: true,
        minChapters: 10,
        maxChapters: 100,
        minRating: 3.5,
        onlyCompleted: true,
        onlyTranslated: true,
        hideOnBreak: true,
      },
    };
    const form = new MgekoAdvancedSearchForm(query, genres);

    await form.handleMaxChaptersChange(125);
    assert.deepEqual(form.getSearchQueryMetadata(), {
      ...query.metadata,
      maxChapters: 125,
    });
    assert.equal(form.getSections().length, 6);
  });

  it("normalizes inverted chapter ranges and omits disabled/default filters", async () => {
    const form = new MgekoAdvancedSearchForm({ title: "" }, genres);
    await form.handleSetChapterCountChange(true);
    await form.handleMinChaptersChange(50);
    await form.handleMaxChaptersChange(10);
    await form.handleMinRatingChange(0);

    assert.deepEqual(form.getSearchQueryMetadata(), {
      setChapterCount: true,
      minChapters: 10,
      maxChapters: 50,
    });
  });
});
