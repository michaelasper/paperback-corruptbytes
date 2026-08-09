import {
  Form,
  NavigationRow,
  Section,
  SelectRow,
  ToggleRow,
  TriStateSelectRow,
  type Tag,
} from "@paperback/types";

import { encodePaperbackIdComponent } from "../shared/ids.js";
import type { AtsumaruTagGroup, AtsumaruTaxonomy, AtsumaruTimeframe } from "./models.js";
import { buildHomeUrl } from "./network.js";
import {
  GENRE_OPTIONS,
  MEDIUM_OPTIONS,
  TYPE_OPTIONS,
  type AtsumaruSearchOptions,
  type TriState,
} from "./search.js";

export const ATSUMARU_DISCOVERY_PREFERENCES_KEY = "atsumaru_discovery_preferences";
export const ATSUMARU_SHOW_ALTERNATE_TRANSLATIONS_KEY = "atsumaru_show_alternate_translations";

/** Short aliases for extensions that used the source name as a prefix. */
export const DISCOVERY_PREFERENCES_KEY = ATSUMARU_DISCOVERY_PREFERENCES_KEY;
export const SHOW_ALTERNATE_TRANSLATIONS_KEY = ATSUMARU_SHOW_ALTERNATE_TRANSLATIONS_KEY;

export type AtsumaruDiscoveryCatalog = "safe" | "adult";

export const TIMEFRAME_OPTIONS: Tag[] = [
  { id: "daily", title: "Daily" },
  { id: "weekly", title: "Weekly" },
  { id: "monthly", title: "Monthly" },
  { id: "all", title: "All time" },
];

export const DISCOVERY_CATALOG_OPTIONS: Tag[] = [
  { id: "safe", title: "Standard catalog" },
  { id: "adult", title: "Adult catalog only" },
];

export interface AtsumaruDiscoveryPreferences {
  catalog: AtsumaruDiscoveryCatalog;
  /** API form: adult=1 means adult-only; the legacy `safe` ID means Standard catalog. */
  adult: boolean;
  types: string[];
  mediums: string[];
  excludedTags: string[];
  popularTimeframe: AtsumaruTimeframe;
  bookmarksTimeframe: AtsumaruTimeframe;
  talkedAboutTimeframe: AtsumaruTimeframe;
  genreSpotlight: string;
  // These aliases make the preference object useful to feed adapters while
  // retaining the explicit per-feed names above.
  timeframe: AtsumaruTimeframe;
  genre: string;
  genreId: string;
}

type TaxonomyLike = Partial<AtsumaruTaxonomy> & {
  id?: string | number;
  name?: string;
  title?: string;
  group?: string;
};

export interface AtsumaruSettingsTaxonomy {
  genres?: readonly TaxonomyLike[];
  tags?: readonly (TaxonomyLike & { group?: string })[];
  tagGroups?: readonly (AtsumaruTagGroup | (TaxonomyLike & { tags?: readonly TaxonomyLike[] }))[];
  availableFilters?: readonly unknown[];
}

type TaxonomyInput = AtsumaruSettingsTaxonomy | AtsumaruSearchOptions | readonly Tag[];

const timeframeValues = new Set<AtsumaruTimeframe>(["daily", "weekly", "monthly", "all"]);
const typeIds = new Set(TYPE_OPTIONS.map(({ id }) => id));
const mediumIds = new Set(MEDIUM_OPTIONS.map(({ id }) => id));

const DISCOVERY_TIMEFRAME_FEEDS = [
  ["popular", "popularTimeframe"],
  ["mostBookmarked", "bookmarksTimeframe"],
  ["mostTalkedAbout", "talkedAboutTimeframe"],
] as const;
const WORST_CASE_TIMEFRAME: AtsumaruTimeframe = "monthly";

const DEFAULT_TYPES = TYPE_OPTIONS.map(({ id }) => id);
const DEFAULT_MEDIUMS = MEDIUM_OPTIONS.map(({ id }) => id);
const UNSUPPORTED_SPOTLIGHT_GENRE_IDS = new Set(["46", "180", "4", "10", "41", "5"]);
const UNSUPPORTED_SPOTLIGHT_GENRE_NAMES = new Set([
  "adult",
  "boys love",
  "girls love",
  "hentai",
  "smut",
  "tragedy",
]);
const LIVE_SPOTLIGHT_GENRE_IDS = new Set(
  GENRE_OPTIONS.filter(({ id }) => !UNSUPPORTED_SPOTLIGHT_GENRE_IDS.has(id)).map(({ id }) => id),
);
const isLiveSpotlightGenre = (tag: Tag): boolean =>
  LIVE_SPOTLIGHT_GENRE_IDS.has(tag.id) &&
  !UNSUPPORTED_SPOTLIGHT_GENRE_NAMES.has(tag.title.trim().toLowerCase());
const LIVE_SPOTLIGHT_GENRE_OPTIONS = GENRE_OPTIONS.filter(isLiveSpotlightGenre);

const copy = (values: readonly string[]): string[] => [...values];

const getState = (key: string): unknown => {
  try {
    return typeof Application.getState === "function" ? Application.getState(key) : undefined;
  } catch {
    return undefined;
  }
};

const setState = (value: unknown, key: string): void => {
  try {
    if (typeof Application.setState === "function") Application.setState(value, key);
  } catch {
    // Application state is optional in test hosts and can be unavailable during
    // source teardown. Preferences remain available for this form instance.
  }
};

const arrayOfStrings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

const validArray = (
  value: unknown,
  allowed: ReadonlySet<string>,
  fallback: readonly string[],
): string[] => {
  if (!Array.isArray(value)) return copy(fallback);
  const result = filteredArray(value, allowed);
  // An empty array is a valid explicit selection. Non-empty arrays with no
  // valid entries are corrupt persisted state and should recover defaults.
  return result.length > 0 || value.length === 0 ? result : copy(fallback);
};

const filteredArray = (value: unknown, allowed: ReadonlySet<string>): string[] => {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of arrayOfStrings(value)) {
    if (!allowed.has(item) || seen.has(item)) continue;
    seen.add(item);
    result.push(item);
  }
  return result;
};

const idOf = (item: TaxonomyLike): string | undefined => {
  if (typeof item.id === "string" && item.id.trim()) return item.id.trim();
  if (typeof item.id === "number" && Number.isFinite(item.id)) return String(item.id);
  return undefined;
};

const titleOf = (item: TaxonomyLike, fallback: string): string => {
  const title = typeof item.name === "string" ? item.name : item.title;
  return typeof title === "string" && title.trim() ? title.trim() : fallback;
};

const asTag = (item: TaxonomyLike): Tag | undefined => {
  const id = idOf(item);
  return id ? { id, title: titleOf(item, id) } : undefined;
};

const settingsTaxonomy = (input: TaxonomyInput | undefined): AtsumaruSettingsTaxonomy => {
  if (Array.isArray(input)) return { genres: input };
  return (input ?? {}) as AtsumaruSettingsTaxonomy;
};

type SettingsTagGroup = {
  id: string;
  name: string;
  tags: Tag[];
  seen: Set<string>;
};

type NormalizedTaxonomyIndex = {
  groups: Array<{ id: string; name: string; tags: Tag[] }>;
  tagIds: Set<string>;
};

// Mutable caller-owned taxonomies must be re-read; the extension supplies a
// deeply frozen filter snapshot, which is safe to index by object identity.
const normalizedTaxonomyCache = new WeakMap<object, NormalizedTaxonomyIndex>();

const tagGroups = (
  input: TaxonomyInput | undefined,
): Array<{ id: string; name: string; tags: Tag[] }> => {
  const taxonomy = settingsTaxonomy(input);
  const groups: SettingsTagGroup[] = [];
  const byId = new Map<string, SettingsTagGroup>();
  const add = (id: string, name: string, rawItems: readonly TaxonomyLike[]) => {
    const safeId = encodePaperbackIdComponent(id);
    let group = byId.get(safeId);
    for (const rawItem of rawItems) {
      const tag = asTag(rawItem);
      if (!tag) continue;
      if (!group) {
        group = { id: safeId, name, tags: [], seen: new Set<string>() };
        groups.push(group);
        byId.set(safeId, group);
      }
      if (group.seen.has(tag.id)) continue;
      group.seen.add(tag.id);
      group.tags.push({ ...tag });
    }
  };
  for (const raw of taxonomy.tagGroups ?? []) {
    const group = raw as TaxonomyLike & { tags?: readonly TaxonomyLike[] };
    const name =
      typeof group.name === "string" && group.name.trim()
        ? group.name.trim()
        : typeof group.title === "string" && group.title.trim()
          ? group.title.trim()
          : "Other tags";
    add(idOf(group) ?? name, name, group.tags ?? []);
  }
  for (const tag of taxonomy.tags ?? []) {
    const name =
      typeof tag.group === "string" && tag.group.trim() ? tag.group.trim() : "Other tags";
    add(name, name, [tag]);
  }
  for (const raw of taxonomy.availableFilters ?? []) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const group =
      typeof item.group === "string" && item.group.trim() ? item.group.trim() : "Other tags";
    const name = typeof item.name === "string" ? item.name.trim() : "";
    if (name) add(group, group, [{ id: name, name }]);
  }
  return groups
    .filter(({ tags }) => tags.length > 0)
    .map(({ id, name, tags }) => ({ id, name, tags }));
};

const normalizedTaxonomyIndex = (input: TaxonomyInput | undefined): NormalizedTaxonomyIndex => {
  const cacheKey =
    input && typeof input === "object" && Object.isFrozen(input) ? (input as object) : undefined;
  if (cacheKey) {
    const cached = normalizedTaxonomyCache.get(cacheKey);
    if (cached) return cached;
  }

  const groups = tagGroups(input);
  const tagIds = new Set<string>();
  for (const group of groups) {
    for (const tag of group.tags) tagIds.add(tag.id);
  }
  const result = { groups, tagIds };
  if (cacheKey) normalizedTaxonomyCache.set(cacheKey, result);
  return result;
};

const genreOptions = (input: TaxonomyInput | undefined): Tag[] => {
  const raw = settingsTaxonomy(input).genres;
  const converted = (raw ?? [])
    .map(asTag)
    .filter((tag): tag is Tag => tag !== undefined)
    .filter(isLiveSpotlightGenre);
  return converted.length > 0
    ? converted.map((tag) => ({ ...tag }))
    : LIVE_SPOTLIGHT_GENRE_OPTIONS.map((tag) => ({ ...tag }));
};

const assertWithinDiscoveryBudget = (
  preferences: AtsumaruDiscoveryPreferences,
  genres: readonly Tag[],
): void => {
  const genre =
    genres.find(({ id }) => id === preferences.genreSpotlight)?.title ??
    LIVE_SPOTLIGHT_GENRE_OPTIONS[0]?.title ??
    "Action";

  const common = {
    adult: preferences.adult,
    types: preferences.types,
    mediums: preferences.mediums,
    excludedTags: preferences.excludedTags,
    // Match the client request shape rather than the URL builder defaults.
    offset: 0,
    limit: 24,
  };
  buildHomeUrl("genreSpotlight", {
    ...common,
    genre,
  });

  for (const [feed, timeframeKey] of DISCOVERY_TIMEFRAME_FEEDS) {
    const selectedTimeframe = preferences[timeframeKey];
    for (const timeframe of new Set([selectedTimeframe, WORST_CASE_TIMEFRAME])) {
      buildHomeUrl(feed, { ...common, timeframe });
    }
  }
};

const boundDiscoveryExclusions = (
  preferences: AtsumaruDiscoveryPreferences,
  genres: readonly Tag[],
): string[] => {
  const exclusions = preferences.excludedTags;
  let lower = 0;
  let upper = exclusions.length;
  while (lower < upper) {
    const count = Math.ceil((lower + upper) / 2);
    try {
      assertWithinDiscoveryBudget(
        { ...preferences, excludedTags: exclusions.slice(0, count) },
        genres,
      );
      lower = count;
    } catch {
      upper = count - 1;
    }
  }
  return exclusions.slice(0, lower);
};

const normalizeCatalog = (raw: unknown): AtsumaruDiscoveryCatalog => {
  if (raw === "adult" || raw === "adult-only" || raw === "only" || raw === true) return "adult";
  return "safe";
};

const normalizeTimeframe = (raw: unknown, fallback: AtsumaruTimeframe): AtsumaruTimeframe =>
  typeof raw === "string" && timeframeValues.has(raw as AtsumaruTimeframe)
    ? (raw as AtsumaruTimeframe)
    : fallback;

const rawPreferences = (): Record<string, unknown> => {
  const value = getState(ATSUMARU_DISCOVERY_PREFERENCES_KEY);
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
};

const buildPreferences = (
  input: TaxonomyInput | undefined,
  taxonomyIndex: NormalizedTaxonomyIndex = normalizedTaxonomyIndex(input),
): AtsumaruDiscoveryPreferences => {
  const raw = rawPreferences();
  const genres = genreOptions(input);
  const genreIds = new Set(genres.map(({ id }) => id));
  const tags = taxonomyIndex.tagIds;
  const genreSpotlight =
    [raw.genreSpotlight, raw.genreId, raw.genre].find(
      (value): value is string => typeof value === "string" && genreIds.has(value),
    ) ??
    genres[0]?.id ??
    "";
  const catalog = normalizeCatalog(raw.catalog ?? raw.adult);
  const types = validArray(raw.types, typeIds, DEFAULT_TYPES);
  const mediums = validArray(raw.mediums, mediumIds, DEFAULT_MEDIUMS);
  const excludedTags: string[] = [];
  const seenExcludedTags = new Set<string>();
  for (const id of arrayOfStrings(raw.excludedTags)) {
    if (tags.has(id) && !seenExcludedTags.has(id)) {
      seenExcludedTags.add(id);
      excludedTags.push(id);
    }
  }
  const popularTimeframe = normalizeTimeframe(raw.popularTimeframe ?? raw.timeframe, "daily");
  const bookmarksTimeframe = normalizeTimeframe(raw.bookmarksTimeframe, "weekly");
  const talkedAboutTimeframe = normalizeTimeframe(raw.talkedAboutTimeframe, "weekly");
  const preferences: AtsumaruDiscoveryPreferences = {
    catalog,
    adult: catalog === "adult",
    types: copy(types),
    mediums: copy(mediums),
    excludedTags: copy(excludedTags),
    popularTimeframe,
    bookmarksTimeframe,
    talkedAboutTimeframe,
    genreSpotlight,
    timeframe: popularTimeframe,
    genre: genreSpotlight,
    genreId: genreSpotlight,
  };
  preferences.excludedTags = boundDiscoveryExclusions(preferences, genres);
  return preferences;
};

export const getAtsumaruDiscoveryPreferences = (
  input?: TaxonomyInput,
): AtsumaruDiscoveryPreferences => {
  const preferences = buildPreferences(input);
  return {
    ...preferences,
    types: copy(preferences.types),
    mediums: copy(preferences.mediums),
    excludedTags: copy(preferences.excludedTags),
  };
};

export const getShowAlternateTranslations = (): boolean => {
  const raw = getState(ATSUMARU_SHOW_ALTERNATE_TRANSLATIONS_KEY);
  return typeof raw === "boolean" ? raw : true;
};

const persisted = (preferences: AtsumaruDiscoveryPreferences): Record<string, unknown> => ({
  catalog: preferences.catalog,
  adult: preferences.adult,
  types: copy(preferences.types),
  mediums: copy(preferences.mediums),
  excludedTags: copy(preferences.excludedTags),
  popularTimeframe: preferences.popularTimeframe,
  bookmarksTimeframe: preferences.bookmarksTimeframe,
  talkedAboutTimeframe: preferences.talkedAboutTimeframe,
  timeframe: preferences.popularTimeframe,
  genreSpotlight: preferences.genreSpotlight,
  genre: preferences.genreSpotlight,
  genreId: preferences.genreSpotlight,
});

class AtsumaruExcludedTagGroupForm extends Form {
  private value: Record<string, TriState>;

  constructor(
    private readonly group: { id: string; name: string; tags: Tag[] },
    selected: readonly string[],
    private readonly onChange: (
      group: AtsumaruExcludedTagGroupForm,
      ids: string[],
    ) => Promise<void>,
  ) {
    super();
    const selectedIds = new Set(selected);
    this.value = Object.fromEntries(
      group.tags.filter(({ id }) => selectedIds.has(id)).map(({ id }) => [id, "included"]),
    ) as Record<string, TriState>;
  }

  override getSections() {
    return [
      Section(this.group.id, [
        TriStateSelectRow("excludedTags", {
          title: this.group.name,
          subtitle: "Hide these tags from discovery.",
          layout: "flow",
          value: { ...this.value },
          items: this.group.tags.map((tag) => ({ ...tag })),
          allowExclusion: false,
          allowEmptySelection: true,
          onValueChange: Application.Selector(
            this as AtsumaruExcludedTagGroupForm,
            "handleExcludedTagsChange",
          ),
        }),
      ]),
    ];
  }

  async handleExcludedTagsChange(value: Record<string, TriState>): Promise<void> {
    const allowed = new Set(this.group.tags.map(({ id }) => id));
    const ids = Object.entries(value)
      .filter(([id, state]) => allowed.has(id) && state === "included")
      .map(([id]) => id);
    await this.onChange(this, [...ids]);
    this.value = Object.fromEntries(ids.map((id) => [id, "included"])) as Record<string, TriState>;
  }
}

export class AtsumaruSettingsForm extends Form {
  private readonly taxonomy: TaxonomyInput | undefined;
  private readonly genres: Tag[];
  private readonly groups: Array<{ id: string; name: string; tags: Tag[] }>;
  private readonly groupForms = new Map<string, AtsumaruExcludedTagGroupForm>();
  private preferences: AtsumaruDiscoveryPreferences;
  private showAlternateTranslations: boolean;

  constructor(taxonomy?: TaxonomyInput) {
    super();
    this.taxonomy = taxonomy;
    const taxonomyIndex = normalizedTaxonomyIndex(taxonomy);
    this.genres = genreOptions(taxonomy);
    this.groups = taxonomyIndex.groups;
    const preferences = buildPreferences(taxonomy, taxonomyIndex);
    this.preferences = {
      ...preferences,
      types: copy(preferences.types),
      mediums: copy(preferences.mediums),
      excludedTags: copy(preferences.excludedTags),
    };
    this.showAlternateTranslations = getShowAlternateTranslations();
    for (const group of this.groups) {
      this.groupForms.set(
        group.id,
        new AtsumaruExcludedTagGroupForm(
          group,
          this.preferences.excludedTags,
          async (form, ids) => {
            await this.handleExcludedTagGroupChange(form, ids);
          },
        ),
      );
    }
  }

  private persist(): void {
    setState(persisted(this.preferences), ATSUMARU_DISCOVERY_PREFERENCES_KEY);
  }

  private updatePreferences(patch: Partial<AtsumaruDiscoveryPreferences>): void {
    const next: AtsumaruDiscoveryPreferences = {
      ...this.preferences,
      ...patch,
      types: patch.types !== undefined ? copy(patch.types) : copy(this.preferences.types),
      mediums: patch.mediums !== undefined ? copy(patch.mediums) : copy(this.preferences.mediums),
      excludedTags:
        patch.excludedTags !== undefined
          ? copy(patch.excludedTags)
          : copy(this.preferences.excludedTags),
    };
    assertWithinDiscoveryBudget(next, this.genres);
    this.preferences = next;
    this.persist();
    this.reloadForm();
  }

  override getSections() {
    const excludedTags = new Set(this.preferences.excludedTags);
    const tagItems = this.groups.map((group) => {
      const selectedCount = group.tags.reduce(
        (count, tag) => count + (excludedTags.has(tag.id) ? 1 : 0),
        0,
      );
      return NavigationRow(`tagGroup-${group.id}`, {
        title: group.name,
        value: selectedCount > 0 ? `${selectedCount} excluded` : undefined,
        subtitle: `${selectedCount} excluded · ${group.tags.length} tags`,
        form: this.groupForms.get(group.id)!,
      });
    });
    return [
      Section(
        {
          id: "preferences",
          footer: "No Atsumaru account is required; public comics and novels are read anonymously.",
        },
        [
          SelectRow("catalog", {
            title: "Discovery catalog",
            subtitle:
              "Standard catalog excludes Atsumaru’s adult/Pornographic catalog; adult-only sends adult=1.",
            layout: "list",
            value: [this.preferences.catalog],
            items: DISCOVERY_CATALOG_OPTIONS.map((item) => ({ ...item })),
            minItemCount: 1,
            maxItemCount: 1,
            onValueChange: Application.Selector(
              this as AtsumaruSettingsForm,
              "handleCatalogChange",
            ),
          }),
          SelectRow("types", {
            title: "Discovery types",
            layout: "flow",
            value: copy(this.preferences.types),
            items: TYPE_OPTIONS.map((item) => ({ ...item })),
            minItemCount: 0,
            maxItemCount: TYPE_OPTIONS.length,
            onValueChange: Application.Selector(this as AtsumaruSettingsForm, "handleTypesChange"),
          }),
          SelectRow("mediums", {
            title: "Discovery mediums",
            layout: "flow",
            value: copy(this.preferences.mediums),
            items: MEDIUM_OPTIONS.map((item) => ({ ...item })),
            minItemCount: 0,
            maxItemCount: MEDIUM_OPTIONS.length,
            onValueChange: Application.Selector(
              this as AtsumaruSettingsForm,
              "handleMediumsChange",
            ),
          }),
          SelectRow("popularTimeframe", {
            title: "Popular timeframe",
            layout: "list",
            value: [this.preferences.popularTimeframe],
            items: TIMEFRAME_OPTIONS.map((item) => ({ ...item })),
            minItemCount: 1,
            maxItemCount: 1,
            onValueChange: Application.Selector(
              this as AtsumaruSettingsForm,
              "handlePopularTimeframeChange",
            ),
          }),
          SelectRow("bookmarksTimeframe", {
            title: "Bookmarks timeframe",
            layout: "list",
            value: [this.preferences.bookmarksTimeframe],
            items: TIMEFRAME_OPTIONS.map((item) => ({ ...item })),
            minItemCount: 1,
            maxItemCount: 1,
            onValueChange: Application.Selector(
              this as AtsumaruSettingsForm,
              "handleBookmarksTimeframeChange",
            ),
          }),
          SelectRow("talkedAboutTimeframe", {
            title: "Talked-about timeframe",
            layout: "list",
            value: [this.preferences.talkedAboutTimeframe],
            items: TIMEFRAME_OPTIONS.map((item) => ({ ...item })),
            minItemCount: 1,
            maxItemCount: 1,
            onValueChange: Application.Selector(
              this as AtsumaruSettingsForm,
              "handleTalkedAboutTimeframeChange",
            ),
          }),
          SelectRow("genreSpotlight", {
            title: "Genre spotlight",
            layout: "list",
            value: [this.preferences.genreSpotlight],
            items: this.genres.map((item) => ({ ...item })),
            minItemCount: 1,
            maxItemCount: 1,
            onValueChange: Application.Selector(
              this as AtsumaruSettingsForm,
              "handleGenreSpotlightChange",
            ),
          }),
          ToggleRow("showAlternateTranslations", {
            title: "Show alternate translations",
            subtitle:
              "Disabling this keeps one translation per chapter number and may hide archived progress.",
            value: this.showAlternateTranslations,
            onValueChange: Application.Selector(
              this as AtsumaruSettingsForm,
              "handleShowAlternateTranslationsChange",
            ),
          }),
        ],
      ),
      ...(tagItems.length > 0 ? [Section("excludedTags", tagItems)] : []),
    ];
  }

  async handleCatalogChange(value: string[]): Promise<void> {
    const catalog: AtsumaruDiscoveryCatalog = value[0] === "adult" ? "adult" : "safe";
    this.updatePreferences({ catalog, adult: catalog === "adult" });
  }

  async handleDiscoveryCatalogChange(value: string[]): Promise<void> {
    await this.handleCatalogChange(value);
  }

  async handleTypesChange(value: string[]): Promise<void> {
    this.updatePreferences({ types: filteredArray(value, typeIds) });
  }

  async handleMediumsChange(value: string[]): Promise<void> {
    this.updatePreferences({ mediums: filteredArray(value, mediumIds) });
  }

  async handlePopularTimeframeChange(value: string[]): Promise<void> {
    const timeframe = normalizeTimeframe(value[0], "daily");
    this.updatePreferences({ popularTimeframe: timeframe, timeframe });
  }

  async handleBookmarksTimeframeChange(value: string[]): Promise<void> {
    this.updatePreferences({ bookmarksTimeframe: normalizeTimeframe(value[0], "weekly") });
  }

  async handleTalkedAboutTimeframeChange(value: string[]): Promise<void> {
    this.updatePreferences({ talkedAboutTimeframe: normalizeTimeframe(value[0], "weekly") });
  }

  async handleGenreSpotlightChange(value: string[]): Promise<void> {
    const ids = new Set(this.genres.map(({ id }) => id));
    const genreSpotlight =
      typeof value[0] === "string" && ids.has(value[0]) ? value[0] : (this.genres[0]?.id ?? "");
    this.updatePreferences({ genreSpotlight, genre: genreSpotlight, genreId: genreSpotlight });
  }

  async handleShowAlternateTranslationsChange(value: boolean): Promise<void> {
    this.showAlternateTranslations = value;
    setState(value, ATSUMARU_SHOW_ALTERNATE_TRANSLATIONS_KEY);
    this.reloadForm();
  }

  async handleExcludedTagGroupChange(
    group: AtsumaruExcludedTagGroupForm,
    ids: string[],
  ): Promise<void> {
    // The form callback carries only its group instance; match by identity to
    // avoid trusting mutable UI IDs.
    const current = [...this.preferences.excludedTags];
    const index = this.groups.findIndex((candidate) => this.groupForms.get(candidate.id) === group);
    const selectedGroup = index >= 0 ? this.groups[index] : undefined;
    if (!selectedGroup) return;
    const groupIds = new Set(selectedGroup.tags.map(({ id }) => id));
    const merged = current.filter((id) => !groupIds.has(id));
    for (const id of ids) if (groupIds.has(id) && !merged.includes(id)) merged.push(id);
    this.updatePreferences({ excludedTags: merged });
  }
}
