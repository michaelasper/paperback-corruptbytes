import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { AtsumaruSearchMetadata } from "./models.js";
import { buildSearchUrl } from "./network.js";
import {
  ADULT_CATALOG_OPTIONS,
  CONTENT_RATING_OPTIONS,
  GENRE_OPTIONS,
  MEDIUM_OPTIONS,
  STATUS_OPTIONS,
  TYPE_OPTIONS,
  AtsumaruAdvancedSearchForm,
} from "./search.js";

const originalApplication = globalThis.Application;

beforeEach(() => {
  Object.assign(globalThis, {
    Application: { Selector: (_form: unknown, method: string) => method },
  });
});

afterEach(() => Object.assign(globalThis, { Application: originalApplication }));

type FilterItem = { id: string; name: string; group?: string };

const filters = {
  genres: GENRE_OPTIONS.map(({ id, title }) => ({ id, name: title })),
  types: TYPE_OPTIONS.map(({ id, title }) => ({ id, name: title })),
  statuses: STATUS_OPTIONS.map(({ id, title }) => ({ id, name: title })),
  tags: Array.from(
    { length: 2_408 },
    (_, index): FilterItem => ({
      id: `tag-${index}`,
      name: `Tag ${index}`,
      group: `Group ${index % 17}`,
    }),
  ),
};

type SearchFormItem = { id: string; value?: unknown };
const findSearchItem = (form: AtsumaruAdvancedSearchForm, id: string): SearchFormItem | undefined =>
  form
    .getSections()
    .flatMap((section) => section.items)
    .find((item) => item.id === id) as SearchFormItem | undefined;

describe("Atsumaru advanced search", () => {
  it("exposes the complete live taxonomy with exact API identifiers", () => {
    assert.equal(GENRE_OPTIONS.length, 21);
    assert.deepEqual(
      TYPE_OPTIONS.map(({ id, title }) => [id, title]),
      [
        ["Manga", "Manga"],
        ["Manwha", "Manhwa"],
        ["Manhua", "Manhua"],
        ["OEL", "OEL"],
      ],
    );
    assert.deepEqual(
      MEDIUM_OPTIONS.map(({ id, title }) => [id, title]),
      [
        ["Comic", "Comic"],
        ["Novel", "Novel"],
      ],
    );
    assert.deepEqual(
      STATUS_OPTIONS.map(({ id }) => id),
      ["Ongoing", "Completed", "Hiatus", "Canceled"],
    );
    assert.deepEqual(
      CONTENT_RATING_OPTIONS.map(({ id }) => [id, id]),
      [
        ["Safe", "Safe"],
        ["Suggestive", "Suggestive"],
        ["Erotica", "Erotica"],
        ["Pornographic", "Pornographic"],
      ],
    );
    assert.deepEqual(
      ADULT_CATALOG_OPTIONS.map(({ id, title }) => [id, title]),
      [
        ["safe", "Standard catalog"],
        ["all", "All catalogs"],
        ["adult", "Adult catalog only"],
      ],
    );
  });

  it("keeps 2,408 tags out of the initial form and exposes one nested row per group", () => {
    const form = new AtsumaruAdvancedSearchForm({ title: "" }, filters);
    const sections = form.getSections();
    const navigationRows = sections
      .flatMap((section) => section.items)
      .filter((item) => item.type === "navigationRow");
    const tagRows = navigationRows.filter((item) => item.id.startsWith("tagGroup-"));

    assert.equal(tagRows.length, 17);
    assert.ok(tagRows.every((item) => !/\s/.test(item.id)));
    assert.equal(
      sections
        .flatMap((section) => section.items)
        .some((item) => item.type === "navigationRow" && "items" in item),
      false,
    );

    const firstTagForm = tagRows[0] as unknown as
      | ({ form: { getSections: () => Array<{ items: Array<{ type: string }> }> } } & Record<
          string,
          unknown
        >)
      | undefined;
    assert.ok(firstTagForm && "form" in firstTagForm);
    const nestedItems = firstTagForm.form.getSections().flatMap((section) => section.items);
    const selector = nestedItems.find((item) => item.type === "navigationRow");
    assert.equal(selector?.type, "navigationRow");
    assert.equal(
      (selector as { form?: { params?: { items?: unknown[] } } } | undefined)?.form?.params?.items
        ?.length,
      142,
    );
  });

  it("round-trips every useful filter while isolating caller-owned state", async () => {
    const genres: Record<string, "included" | "excluded"> = {
      "39": "included",
      "46": "excluded",
    };
    const tags: Record<string, "included" | "excluded"> = {
      "tag-4": "included",
      "tag-19": "excluded",
    };
    const years = [2024, 2020];
    const metadata: AtsumaruSearchMetadata = {
      genres,
      tags,
      types: ["Manga", "Manwha"],
      mediums: ["Comic"],
      statuses: ["Ongoing", "Hiatus"],
      adult: "adult",
      contentRatings: ["Safe", "Pornographic"],
      years,
      minChapters: 24,
      officialTranslation: true,
    };
    const form = new AtsumaruAdvancedSearchForm({ title: "", metadata }, filters);
    genres["39"] = "excluded";
    tags["tag-4"] = "excluded";
    years.reverse();

    assert.deepEqual(form.getSearchQueryMetadata(), {
      genres: { "39": "included", "46": "excluded" },
      tags: { "tag-4": "included", "tag-19": "excluded" },
      types: ["Manga", "Manwha"],
      mediums: ["Comic"],
      statuses: ["Ongoing", "Hiatus"],
      adult: "adult",
      contentRatings: ["Safe", "Pornographic"],
      years: [2020, 2024],
      minChapters: 24,
      officialTranslation: true,
    });
  });

  it("uses standard defaults, omits no-op filters, and normalizes years and chapters", async () => {
    const form = new AtsumaruAdvancedSearchForm(
      { title: "" },
      { ...filters, tags: filters.tags.slice(0, 1) },
    );
    assert.deepEqual(form.getSearchQueryMetadata(), {});

    await form.handleAdultCatalogChange(["safe"]);
    await form.handleContentRatingsChange(["Safe", "Suggestive", "Erotica"]);
    await form.handleEnableYearsChange(true);
    await form.handleMinYearChange(2045);
    await form.handleMaxYearChange(1960);
    await form.handleEnableChaptersChange(true);
    await form.handleMinChaptersChange(20_500);
    await form.handleOfficialTranslationChange(true);

    assert.deepEqual(form.getSearchQueryMetadata(), {
      years: [1970, new Date().getFullYear() + 1],
      minChapters: 9_999,
      officialTranslation: true,
      contentRatings: ["Safe", "Suggestive", "Erotica"],
    });
  });

  it("switches implicit rating defaults with the catalog and round-trips them", async () => {
    const form = new AtsumaruAdvancedSearchForm({ title: "" }, filters);

    const contentRow = () => findSearchItem(form, "contentRatings");
    assert.equal(contentRow()?.value, "3 items");

    await form.handleAdultCatalogChange(["all"]);

    assert.deepEqual(form.getSearchQueryMetadata(), { adult: "all" });
    assert.equal(contentRow()?.value, "4 items");

    const reopened = new AtsumaruAdvancedSearchForm(
      { title: "", metadata: form.getSearchQueryMetadata() },
      filters,
    );
    const reopenedContentRow = findSearchItem(reopened, "contentRatings");
    assert.equal(reopenedContentRow?.value, "4 items");
    assert.deepEqual(reopened.getSearchQueryMetadata(), { adult: "all" });

    await reopened.handleAdultCatalogChange(["adult"]);
    const adultContentRow = findSearchItem(reopened, "contentRatings");
    assert.equal(adultContentRow?.value, "4 items");
    assert.deepEqual(reopened.getSearchQueryMetadata(), { adult: "adult" });

    await reopened.handleAdultCatalogChange(["safe"]);
    const standardContentRow = findSearchItem(reopened, "contentRatings");
    assert.equal(standardContentRow?.value, "3 items");
    assert.deepEqual(reopened.getSearchQueryMetadata(), {});
  });

  it("preserves an explicitly selected rating subset while using all catalogs", async () => {
    const form = new AtsumaruAdvancedSearchForm({ title: "" }, filters);

    await form.handleAdultCatalogChange(["all"]);
    await form.handleContentRatingsChange(["Safe", "Suggestive", "Erotica"]);

    assert.deepEqual(form.getSearchQueryMetadata(), {
      adult: "all",
      contentRatings: ["Safe", "Suggestive", "Erotica"],
    });

    const reopened = new AtsumaruAdvancedSearchForm(
      { title: "", metadata: form.getSearchQueryMetadata() },
      filters,
    );
    assert.deepEqual(reopened.getSearchQueryMetadata(), {
      adult: "all",
      contentRatings: ["Safe", "Suggestive", "Erotica"],
    });
  });

  it("preserves an explicit all-ratings selection while keeping the network filter a no-op", async () => {
    const form = new AtsumaruAdvancedSearchForm({ title: "" }, filters);

    await form.handleAdultCatalogChange(["all"]);
    await form.handleContentRatingsChange(["Safe", "Suggestive", "Erotica", "Pornographic"]);

    const metadata = form.getSearchQueryMetadata();
    assert.deepEqual(metadata, {
      adult: "all",
      contentRatings: ["Safe", "Suggestive", "Erotica", "Pornographic"],
    });
    assert.doesNotMatch(
      new URL(buildSearchUrl({ title: "", metadata }, undefined, 1)).searchParams.get(
        "filter_by",
      ) ?? "",
      /mbContentRating/,
    );
    const reopened = new AtsumaruAdvancedSearchForm({ title: "", metadata }, filters);
    const contentRow = findSearchItem(reopened, "contentRatings");
    assert.equal(contentRow?.value, "4 items");
    assert.deepEqual(reopened.getSearchQueryMetadata(), metadata);
  });

  it("preserves an explicit empty rating selection instead of restoring defaults", () => {
    const form = new AtsumaruAdvancedSearchForm(
      { title: "", metadata: { contentRatings: [] } },
      filters,
    );
    const contentRow = findSearchItem(form, "contentRatings");

    assert.equal(contentRow?.value, "0 items");
    const metadata = form.getSearchQueryMetadata();
    assert.deepEqual(metadata, { contentRatings: [] });
    assert.doesNotMatch(
      new URL(buildSearchUrl({ title: "", metadata }, undefined, 1)).searchParams.get(
        "filter_by",
      ) ?? "",
      /mbContentRating/,
    );

    const reopened = new AtsumaruAdvancedSearchForm({ title: "", metadata }, filters);
    const reopenedContentRow = findSearchItem(reopened, "contentRatings");
    assert.equal(reopenedContentRow?.value, "0 items");
    assert.deepEqual(reopened.getSearchQueryMetadata(), metadata);
  });

  it("falls back to implicit catalog defaults for invalid rating metadata", () => {
    const standard = new AtsumaruAdvancedSearchForm(
      { title: "", metadata: { contentRatings: ["unknown"] } },
      filters,
    );
    const standardRow = findSearchItem(standard, "contentRatings");
    assert.equal(standardRow?.value, "3 items");
    assert.deepEqual(standard.getSearchQueryMetadata(), {});

    const all = new AtsumaruAdvancedSearchForm(
      { title: "", metadata: { adult: "all", contentRatings: ["unknown"] } },
      filters,
    );
    const allRow = findSearchItem(all, "contentRatings");
    assert.equal(allRow?.value, "4 items");
    assert.deepEqual(all.getSearchQueryMetadata(), { adult: "all" });
  });

  it("keeps an explicit rating selection while switching catalogs", async () => {
    const form = new AtsumaruAdvancedSearchForm({ title: "" }, filters);

    await form.handleContentRatingsChange(["Safe"]);
    await form.handleAdultCatalogChange(["all"]);
    assert.deepEqual(form.getSearchQueryMetadata(), {
      adult: "all",
      contentRatings: ["Safe"],
    });

    await form.handleAdultCatalogChange(["adult"]);
    assert.deepEqual(form.getSearchQueryMetadata(), {
      adult: "adult",
      contentRatings: ["Safe"],
    });
  });

  it("merges nested tag changes without losing another group", async () => {
    const form = new AtsumaruAdvancedSearchForm({ title: "" }, filters);
    const first = form
      .getSections()
      .flatMap((section) => section.items)
      .find((item) => item.id === "tagGroup-Group%200");
    const second = form
      .getSections()
      .flatMap((section) => section.items)
      .find((item) => item.id === "tagGroup-Group%201");
    assert.ok(first && second && "form" in first && "form" in second);

    const firstForm = (first as { form: { getSections: () => Array<{ items: unknown[] }> } }).form;
    const secondForm = (second as { form: { getSections: () => Array<{ items: unknown[] }> } })
      .form;
    const firstSelector = firstForm.getSections()[0]?.items[0] as {
      form?: { params?: { onValueChange?: string } };
    };
    const secondSelector = secondForm.getSections()[0]?.items[0] as {
      form?: { params?: { onValueChange?: string } };
    };
    assert.equal(firstSelector.form?.params?.onValueChange, "handleTagGroupChange");
    assert.equal(secondSelector.form?.params?.onValueChange, "handleTagGroupChange");
    await (
      firstForm as unknown as {
        handleTagGroupChange: (value: Record<string, "included" | "excluded">) => Promise<void>;
      }
    ).handleTagGroupChange({
      "tag-0": "included",
    });
    await (
      secondForm as unknown as {
        handleTagGroupChange: (value: Record<string, "included" | "excluded">) => Promise<void>;
      }
    ).handleTagGroupChange({
      "tag-1": "excluded",
    });
    assert.deepEqual(form.getSearchQueryMetadata().tags, {
      "tag-0": "included",
      "tag-1": "excluded",
    });
  });

  it("rejects tag changes before they exceed the live Typesense budgets", async () => {
    const form = new AtsumaruAdvancedSearchForm({ title: "" }, filters);
    const tagRows = form
      .getSections()
      .flatMap((section) => section.items)
      .filter((item) => item.id.startsWith("tagGroup-"));
    const firstForm = (tagRows[0] as unknown as { form: unknown }).form as {
      getSections: () => Array<{
        items: Array<{ form?: { params?: { items?: { id: string }[] } } }>;
      }>;
      handleTagGroupChange: (value: Record<string, "included" | "excluded">) => Promise<void>;
    };
    const firstIds = firstForm.getSections()[0]!.items[0]!.form!.params!.items!.map(({ id }) => id);

    await assert.rejects(
      firstForm.handleTagGroupChange(
        Object.fromEntries(firstIds.slice(0, 60).map((id) => [id, "included"])),
      ),
      /too many simultaneous filters|Reduce tag selections/i,
    );
    assert.equal(form.getSearchQueryMetadata().tags, undefined);

    let rejected = false;
    for (const row of tagRows) {
      const child = (row as unknown as { form: typeof firstForm }).form;
      const ids = child.getSections()[0]!.items[0]!.form!.params!.items!.map(({ id }) => id);
      try {
        await child.handleTagGroupChange(Object.fromEntries(ids.map((id) => [id, "excluded"])));
      } catch (error: unknown) {
        assert.match(error instanceof Error ? error.message : String(error), /query is too large/i);
        rejected = true;
        break;
      }
    }
    assert.equal(rejected, true);
    const metadata = form.getSearchQueryMetadata();
    assert.doesNotThrow(() => buildSearchUrl({ title: "", metadata }, undefined, 1));
  });

  it("reserves one filter operation and URL budget for every advertised sort", async () => {
    const form = new AtsumaruAdvancedSearchForm({ title: "hero" }, filters);
    const row = form
      .getSections()
      .flatMap((section) => section.items)
      .find((item) => item.id === "tagGroup-Group%200");
    assert.ok(row && "form" in row);

    const child = (row as { form: unknown }).form as {
      getSections: () => Array<{
        items: Array<{ form?: { params?: { items?: { id: string }[] } } }>;
      }>;
      handleTagGroupChange: (value: Record<string, "included">) => Promise<void>;
    };
    const ids = child.getSections()[0]!.items[0]!.form!.params!.items!.map(({ id }) => id);

    await child.handleTagGroupChange(
      Object.fromEntries(ids.slice(0, 47).map((id) => [id, "included"])),
    );
    assert.equal(Object.keys(form.getSearchQueryMetadata().tags ?? {}).length, 47);

    await assert.rejects(
      child.handleTagGroupChange(
        Object.fromEntries(ids.slice(0, 48).map((id) => [id, "included"])),
      ),
      /too many simultaneous filters|query is too large/i,
    );
    assert.equal(Object.keys(form.getSearchQueryMetadata().tags ?? {}).length, 47);
  });
});
