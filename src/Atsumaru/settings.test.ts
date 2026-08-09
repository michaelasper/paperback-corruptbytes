import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { buildHomeUrl } from "./network.js";
import { GENRE_OPTIONS } from "./search.js";
import {
  ATSUMARU_DISCOVERY_PREFERENCES_KEY,
  ATSUMARU_SHOW_ALTERNATE_TRANSLATIONS_KEY,
  AtsumaruSettingsForm,
  getAtsumaruDiscoveryPreferences,
  getShowAlternateTranslations,
} from "./settings.js";

const originalApplication = globalThis.Application;
let state = new Map<string, unknown>();
const UNSUPPORTED_GENRE_IDS = new Set(["46", "180", "4", "10", "41", "5"]);
const LIVE_GENRES = GENRE_OPTIONS.filter(({ id }) => !UNSUPPORTED_GENRE_IDS.has(id));
const GENRE_TAXONOMY = GENRE_OPTIONS.map(({ id, title }) => ({ id, name: title }));
const LARGE_TAGS = Array.from({ length: 2_408 }, (_, index) => ({
  id: `tag-${index}`,
  name: `Tag ${index}`,
  group: `Group ${index % 17}`,
}));
const BOUNDARY_TAGS = LARGE_TAGS.slice(0, 391);

beforeEach(() => {
  state = new Map();
  Object.assign(globalThis, {
    Application: {
      Selector: (_form: unknown, method: string) => method,
      getState: (key: string) => state.get(key),
      setState: (value: unknown, key: string) => state.set(key, value),
    },
  });
});

afterEach(() => Object.assign(globalThis, { Application: originalApplication }));

describe("Atsumaru settings", () => {
  it("uses standard anonymous defaults and explains public reading", () => {
    const preferences = getAtsumaruDiscoveryPreferences(GENRE_OPTIONS);
    assert.equal(preferences.catalog, "safe");
    assert.deepEqual(preferences.types, ["Manga", "Manwha", "Manhua", "OEL"]);
    assert.deepEqual(preferences.mediums, ["Comic", "Novel"]);
    assert.equal("contentRatings" in preferences, false);
    assert.equal(preferences.popularTimeframe, "daily");
    assert.equal(preferences.bookmarksTimeframe, "weekly");
    assert.equal(preferences.talkedAboutTimeframe, "weekly");
    assert.equal(preferences.genreSpotlight, LIVE_GENRES[0]?.id);
    assert.equal(getShowAlternateTranslations(), true);

    const section = new AtsumaruSettingsForm(GENRE_OPTIONS).getSections()[0]!;
    assert.match(String(section.footer), /no Atsumaru account is required/i);
    assert.match(String(section.footer), /anonymously/i);
    const catalog = section.items.find((item) => item.id === "catalog") as unknown as
      | { value?: unknown; subtitle?: unknown }
      | undefined;
    assert.equal(catalog?.value, "Standard catalog");
    assert.match(String(catalog?.subtitle), /adult\/Pornographic catalog/i);
  });

  it("parses corrupt state safely, validates taxonomy IDs, and clones arrays", () => {
    state.set(ATSUMARU_DISCOVERY_PREFERENCES_KEY, {
      catalog: "include-adult",
      types: ["Manga", "unknown", 1],
      mediums: ["Novel", "bad"],
      contentRatings: ["Pornographic", "bad"],
      popularTimeframe: "fortnightly",
      bookmarksTimeframe: "monthly",
      talkedAboutTimeframe: "all",
      genreSpotlight: "not-a-genre",
      excludedTags: ["tag-1", 2],
    });
    state.set(ATSUMARU_SHOW_ALTERNATE_TRANSLATIONS_KEY, { value: false });
    const preferences = getAtsumaruDiscoveryPreferences(GENRE_OPTIONS);
    assert.equal(preferences.catalog, "safe");
    assert.deepEqual(preferences.types, ["Manga"]);
    assert.deepEqual(preferences.mediums, ["Novel"]);
    assert.equal("contentRatings" in preferences, false);
    assert.equal(preferences.popularTimeframe, "daily");
    assert.equal(preferences.bookmarksTimeframe, "monthly");
    assert.equal(preferences.talkedAboutTimeframe, "all");
    assert.equal(preferences.genreSpotlight, LIVE_GENRES[0]?.id);
    assert.deepEqual(preferences.excludedTags, []);
    assert.equal(getShowAlternateTranslations(), true);
  });

  it("rereads dynamic preferences while reusing the taxonomy index", () => {
    const taxonomy = Object.freeze({
      genres: Object.freeze(GENRE_TAXONOMY.map((tag) => Object.freeze({ ...tag }))),
      tags: Object.freeze([Object.freeze({ id: "tag-1", name: "Tag 1" })]),
    });
    state.set(ATSUMARU_DISCOVERY_PREFERENCES_KEY, {
      mediums: ["Comic"],
      excludedTags: ["tag-1"],
    });
    const first = getAtsumaruDiscoveryPreferences(taxonomy);

    state.set(ATSUMARU_DISCOVERY_PREFERENCES_KEY, {
      mediums: ["Novel"],
      excludedTags: [],
    });
    const second = getAtsumaruDiscoveryPreferences(taxonomy);

    assert.deepEqual(first.mediums, ["Comic"]);
    assert.deepEqual(first.excludedTags, ["tag-1"]);
    assert.deepEqual(second.mediums, ["Novel"]);
    assert.deepEqual(second.excludedTags, []);
  });

  it("persists settings changes and keeps alternate translations enabled by default", async () => {
    const form = new AtsumaruSettingsForm(GENRE_OPTIONS);
    await form.handleCatalogChange(["adult"]);
    await form.handleTypesChange(["Manhua"]);
    await form.handleMediumsChange(["Novel"]);
    await form.handlePopularTimeframeChange(["monthly"]);
    await form.handleBookmarksTimeframeChange(["all"]);
    await form.handleTalkedAboutTimeframeChange(["daily"]);
    await form.handleGenreSpotlightChange([LIVE_GENRES[1]?.id ?? ""]);
    await form.handleShowAlternateTranslationsChange(false);

    const preferences = getAtsumaruDiscoveryPreferences(GENRE_OPTIONS);
    assert.equal(preferences.catalog, "adult");
    assert.deepEqual(preferences.types, ["Manhua"]);
    assert.deepEqual(preferences.mediums, ["Novel"]);
    assert.equal("contentRatings" in preferences, false);
    assert.equal(preferences.popularTimeframe, "monthly");
    assert.equal(preferences.bookmarksTimeframe, "all");
    assert.equal(preferences.talkedAboutTimeframe, "daily");
    assert.equal(preferences.genreSpotlight, LIVE_GENRES[1]?.id);
    assert.equal(getShowAlternateTranslations(), false);
    assert.equal(state.get(ATSUMARU_SHOW_ALTERNATE_TRANSLATIONS_KEY) as unknown, false);

    const clone = getAtsumaruDiscoveryPreferences(GENRE_OPTIONS);
    clone.types.push("OEL");
    assert.deepEqual(getAtsumaruDiscoveryPreferences(GENRE_OPTIONS).types, ["Manhua"]);
  });

  it("uses Paperback-safe IDs for live tag groups while preserving visible names", () => {
    const form = new AtsumaruSettingsForm({
      genres: GENRE_TAXONOMY,
      tags: [{ id: "250", name: "Black-Haired Lead", group: "Character Traits" }],
    });
    const row = form
      .getSections()
      .flatMap((section) => section.items)
      .find((item) => item.id.startsWith("tagGroup-"));

    assert.equal(row?.id, "tagGroup-Character%20Traits");
    assert.equal((row as { title?: string } | undefined)?.title, "Character Traits");
  });

  it("bounds oversized persisted exclusions to a valid discovery query", () => {
    state.set(ATSUMARU_DISCOVERY_PREFERENCES_KEY, {
      excludedTags: LARGE_TAGS.map(({ id }) => id),
    });
    const taxonomy = { genres: GENRE_TAXONOMY, tags: LARGE_TAGS };
    const preferences = getAtsumaruDiscoveryPreferences(taxonomy);

    assert.ok(preferences.excludedTags.length > 0);
    assert.ok(preferences.excludedTags.length < LARGE_TAGS.length);
    assert.doesNotThrow(() =>
      buildHomeUrl("genreSpotlight", {
        ...preferences,
        genre: "Action",
      }),
    );
  });

  it("bounds the 391-exclusion boundary for every timeframe rail", () => {
    state.set(ATSUMARU_DISCOVERY_PREFERENCES_KEY, {
      excludedTags: BOUNDARY_TAGS.map(({ id }) => id),
    });
    const taxonomy = { genres: GENRE_TAXONOMY, tags: BOUNDARY_TAGS };
    const preferences = getAtsumaruDiscoveryPreferences(taxonomy);

    assert.equal(preferences.excludedTags.length, 390);
    for (const feed of ["popular", "mostBookmarked", "mostTalkedAbout"] as const) {
      for (const timeframe of ["daily", "weekly", "monthly", "all"] as const) {
        assert.doesNotThrow(() =>
          buildHomeUrl(feed, { ...preferences, timeframe, genre: "Action" }),
        );
      }
    }
  });

  it("does not persist an exclusion that would overflow a timeframe rail", async () => {
    const taxonomy = { genres: GENRE_TAXONOMY, tags: BOUNDARY_TAGS };
    const persisted = { excludedTags: BOUNDARY_TAGS.slice(0, 390).map(({ id }) => id) };
    state.set(ATSUMARU_DISCOVERY_PREFERENCES_KEY, persisted);
    const form = new AtsumaruSettingsForm(taxonomy);
    const row = form
      .getSections()
      .flatMap((section) => section.items)
      .find((item) => item.id === "tagGroup-Group%2016");
    assert.ok(row && "form" in row);

    const child = (row as { form: unknown }).form as {
      getSections: () => Array<{
        items: Array<{ form?: { params?: { items?: { id: string }[] } } }>;
      }>;
      handleExcludedTagsChange: (value: Record<string, "included">) => Promise<void>;
    };
    const ids = child.getSections()[0]!.items[0]!.form!.params!.items!.map(({ id }) => id);

    await assert.rejects(
      child.handleExcludedTagsChange(Object.fromEntries(ids.map((id) => [id, "included"]))),
      /query is too large/i,
    );
    assert.deepEqual(state.get(ATSUMARU_DISCOVERY_PREFERENCES_KEY), persisted);
  });

  it("rejects oversized exclusion changes before persisting them", async () => {
    const taxonomy = { genres: GENRE_TAXONOMY, tags: LARGE_TAGS };
    const form = new AtsumaruSettingsForm(taxonomy);
    const tagRows = form
      .getSections()
      .flatMap((section) => section.items)
      .filter((item) => item.id.startsWith("tagGroup-"));
    let rejected = false;
    for (const row of tagRows) {
      const child = (row as unknown as { form: unknown }).form as {
        getSections: () => Array<{
          items: Array<{ form?: { params?: { items?: { id: string }[] } } }>;
        }>;
        handleExcludedTagsChange: (value: Record<string, "included">) => Promise<void>;
      };
      const ids = child.getSections()[0]!.items[0]!.form!.params!.items!.map(({ id }) => id);
      try {
        await child.handleExcludedTagsChange(Object.fromEntries(ids.map((id) => [id, "included"])));
      } catch (error: unknown) {
        assert.match(error instanceof Error ? error.message : String(error), /query is too large/i);
        rejected = true;
        break;
      }
    }

    assert.equal(rejected, true);
    const saved = state.get(ATSUMARU_DISCOVERY_PREFERENCES_KEY) as Record<string, unknown>;
    const exclusions = (saved.excludedTags ?? []) as string[];
    assert.doesNotThrow(() =>
      buildHomeUrl("genreSpotlight", { ...saved, excludedTags: exclusions, genre: "Action" }),
    );
  });

  it("limits genre spotlight to the 15 supported genres while retaining the full taxonomy", () => {
    assert.equal(GENRE_OPTIONS.length, 21);
    assert.equal(LIVE_GENRES.length, 15);

    const row = new AtsumaruSettingsForm({ genres: GENRE_TAXONOMY })
      .getSections()[0]!
      .items.find((item) => item.id === "genreSpotlight") as
      | {
          form?: {
            getSections: () => Array<{ items?: readonly { id: string; title: string }[] }>;
          };
        }
      | undefined;
    const items = row?.form?.getSections()[0]?.items;

    assert.deepEqual(
      items?.map(({ id }) => id),
      LIVE_GENRES.map(({ id }) => id),
    );
    assert.deepEqual(
      items?.map(({ title }) => title),
      LIVE_GENRES.map(({ title }) => title),
    );
  });

  it("falls back from persisted unsupported genre spotlight values", () => {
    state.set(ATSUMARU_DISCOVERY_PREFERENCES_KEY, {
      genreSpotlight: "46",
      genreId: "180",
    });

    const preferences = getAtsumaruDiscoveryPreferences({ genres: GENRE_TAXONOMY });
    assert.equal(preferences.genreSpotlight, LIVE_GENRES[0]?.id);
    assert.equal(preferences.genre, LIVE_GENRES[0]?.id);
    assert.equal(preferences.genreId, LIVE_GENRES[0]?.id);
  });

  it("preserves explicit empty multi-select values in state and rows", async () => {
    state.set(ATSUMARU_DISCOVERY_PREFERENCES_KEY, {
      types: [],
      mediums: [],
    });
    const form = new AtsumaruSettingsForm(GENRE_OPTIONS);

    const rows = () =>
      form
        .getSections()[0]!
        .items.filter((item) => ["types", "mediums"].includes(item.id)) as unknown as Array<{
        id: string;
        value?: string;
      }>;
    assert.deepEqual(
      rows().map(({ value }) => value),
      ["0 items", "0 items"],
    );

    await form.handleTypesChange([]);
    await form.handleMediumsChange([]);

    const saved = state.get(ATSUMARU_DISCOVERY_PREFERENCES_KEY) as Record<string, unknown>;
    assert.deepEqual(saved.types, []);
    assert.deepEqual(saved.mediums, []);
    assert.equal("contentRatings" in saved, false);
    assert.deepEqual(getAtsumaruDiscoveryPreferences(GENRE_OPTIONS).types, []);
    assert.deepEqual(getAtsumaruDiscoveryPreferences(GENRE_OPTIONS).mediums, []);
    assert.equal("contentRatings" in getAtsumaruDiscoveryPreferences(GENRE_OPTIONS), false);
  });
});
