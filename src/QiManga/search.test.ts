import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { QiMangaAdvancedSearchForm, STATUS_OPTIONS, TYPE_OPTIONS } from "./search.js";

const originalApplication = globalThis.Application;

beforeEach(() => {
  Object.assign(globalThis, {
    Application: {
      Selector: (_form: unknown, method: string) => method,
    },
  });
});

afterEach(() => Object.assign(globalThis, { Application: originalApplication }));

const genres = [
  { id: "action", title: "Action" },
  { id: "adventure-589", title: "Adventure" },
];

describe("Qi Manga advanced search", () => {
  it("round-trips the site's single-value filters", () => {
    const form = new QiMangaAdvancedSearchForm(
      { title: "", metadata: { genre: "action", status: "ONGOING", type: "MANHWA" } },
      genres,
    );
    assert.deepEqual(form.getSearchQueryMetadata(), {
      genre: "action",
      status: "ONGOING",
      type: "MANHWA",
    });

    const sections = form.getSections();
    assert.equal(sections.length, 2);
    assert.ok(sections[0]);
    assert.ok(sections[1]);
    assert.match(sections[0].footer ?? "", /browsing without a title/);
    assert.equal((sections[0].items[0] as { value?: string }).value, "Action");
    assert.equal((sections[1].items[0] as { value?: string }).value, "Ongoing");
    assert.equal((sections[1].items[1] as { value?: string }).value, "Manhwa");
  });

  it("enforces one selected value and omits empty metadata", async () => {
    const form = new QiMangaAdvancedSearchForm({ title: "" }, genres);
    await form.handleGenreChange(["adventure-589", "action"]);
    await form.handleStatusChange(["HIATUS", "DROPPED"]);
    await form.handleTypeChange(["NOVEL", "MANGA"]);
    assert.deepEqual(form.getSearchQueryMetadata(), {
      genre: "adventure-589",
      status: "HIATUS",
      type: "NOVEL",
    });

    await form.handleGenreChange(["unlisted"]);
    await form.handleStatusChange(["INVALID"]);
    await form.handleTypeChange(["AUDIOBOOK"]);
    assert.deepEqual(form.getSearchQueryMetadata(), {});
  });

  it("isolates live taxonomy and row state from caller mutation", () => {
    const incoming = genres.map((genre) => ({ ...genre }));
    const form = new QiMangaAdvancedSearchForm(
      { title: "", metadata: { genre: "action" } },
      incoming,
    );
    incoming[0]!.title = "Changed outside";
    type SelectNavigationRow = {
      form: { params: { items: { id: string; title: string }[]; value: string[] } };
    };
    const first = form.getSections();
    const genreParams = (first[0]!.items[0] as unknown as SelectNavigationRow).form.params;
    genreParams.items[0]!.title = "Changed inside";
    genreParams.value.length = 0;

    const next = form.getSections();
    const isolatedParams = (next[0]!.items[0] as unknown as SelectNavigationRow).form.params;
    assert.equal(isolatedParams.items[0]?.title, "Action");
    assert.deepEqual(isolatedParams.value, ["action"]);
  });

  it("matches every live status and format enum", () => {
    assert.deepEqual(
      STATUS_OPTIONS.map((item) => item.id),
      ["ONGOING", "COMPLETED", "HIATUS", "DROPPED"],
    );
    assert.deepEqual(
      TYPE_OPTIONS.map((item) => item.id),
      ["MANGA", "MANHWA", "MANHUA", "NOVEL"],
    );
  });
});
