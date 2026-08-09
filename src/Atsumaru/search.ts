import {
  AdvancedSearchForm,
  NavigationRow,
  Section,
  SelectRow,
  StepperRow,
  ToggleRow,
  TriStateSelectRow,
  Form,
  type SearchQuery,
  type Tag,
} from "@paperback/types";

import { encodePaperbackIdComponent } from "../shared/ids.js";
import type {
  AtsumaruAdultPolicy,
  AtsumaruFilterOptions,
  AtsumaruSearchMetadata,
  AtsumaruTagGroup,
  AtsumaruTaxonomy,
  AtsumaruTaxonomyState,
} from "./models.js";
import { buildSearchUrl } from "./network.js";

export type TriState = AtsumaruTaxonomyState;

type TaxonomyLike = Partial<AtsumaruTaxonomy> & {
  id?: string | number;
  name?: string;
  title?: string;
  group?: string;
};

/** The complete live Atsumaru genre list (the API currently returns 21). */
export const GENRE_OPTIONS: Tag[] = [
  { id: "39", title: "Action" },
  { id: "46", title: "Adult" },
  { id: "37", title: "Adventure" },
  { id: "180", title: "Boys Love" },
  { id: "6", title: "Comedy" },
  { id: "31", title: "Drama" },
  { id: "36", title: "Fantasy" },
  { id: "4", title: "Girls Love" },
  { id: "10", title: "Hentai" },
  { id: "45", title: "Historical" },
  { id: "44", title: "Horror" },
  { id: "29", title: "Martial Arts" },
  { id: "32", title: "Mystery" },
  { id: "18", title: "Psychological" },
  { id: "9", title: "Romance" },
  { id: "1", title: "Sci-Fi" },
  { id: "7", title: "Slice of Life" },
  { id: "41", title: "Smut" },
  { id: "22", title: "Supernatural" },
  { id: "19", title: "Thriller" },
  { id: "5", title: "Tragedy" },
];

export const TYPE_OPTIONS: Tag[] = [
  { id: "Manga", title: "Manga" },
  { id: "Manwha", title: "Manhwa" },
  { id: "Manhua", title: "Manhua" },
  { id: "OEL", title: "OEL" },
];

export const MEDIUM_OPTIONS: Tag[] = [
  { id: "Comic", title: "Comic" },
  { id: "Novel", title: "Novel" },
];

export const STATUS_OPTIONS: Tag[] = [
  { id: "Ongoing", title: "Ongoing" },
  { id: "Completed", title: "Completed" },
  { id: "Hiatus", title: "Hiatus" },
  { id: "Canceled", title: "Canceled" },
];

export const CONTENT_RATING_OPTIONS: Tag[] = [
  { id: "Safe", title: "Safe" },
  { id: "Suggestive", title: "Suggestive" },
  { id: "Erotica", title: "Erotica" },
  { id: "Pornographic", title: "Pornographic" },
];

export const ADULT_CATALOG_OPTIONS: Tag[] = [
  { id: "safe", title: "Standard catalog" },
  { id: "all", title: "All catalogs" },
  { id: "adult", title: "Adult catalog only" },
];

/** Aliases kept intentionally boring for callers that used generic names. */
export const GENRES = GENRE_OPTIONS;
export const TYPES = TYPE_OPTIONS;
export const MEDIUMS = MEDIUM_OPTIONS;
export const STATUSES = STATUS_OPTIONS;
export const CONTENT_RATINGS = CONTENT_RATING_OPTIONS;
export const ADULT_OPTIONS = ADULT_CATALOG_OPTIONS;

export const YEAR_MIN = 1970;
export const currentYear = (): number => new Date().getFullYear();

export interface AtsumaruSearchTaxonomy {
  genres?: readonly TaxonomyLike[];
  tags?: readonly (TaxonomyLike & { group?: string })[];
  tagGroups?: readonly (AtsumaruTagGroup | (TaxonomyLike & { tags?: readonly TaxonomyLike[] }))[];
  types?: readonly TaxonomyLike[];
  mediums?: readonly TaxonomyLike[];
  statuses?: readonly TaxonomyLike[];
  contentRatings?: readonly TaxonomyLike[];
  availableFilters?: readonly unknown[];
}

export type AtsumaruSearchOptions = AtsumaruSearchTaxonomy | AtsumaruFilterOptions;

const standardRatings = ["Safe", "Suggestive", "Erotica"] as const;
const stateValues = new Set<AtsumaruTaxonomyState>(["included", "excluded"]);
const adultValues = new Set<AtsumaruAdultPolicy>(["safe", "all", "adult", "only"]);

// Keep the form's budget conservative enough for every sort exposed by the
// extension. Some sorts add a Typesense filter clause, while all non-relevance
// sorts add URL bytes, so validating only the default request is insufficient.
const SEARCH_BUDGET_SORTING_IDS = [
  "relevance",
  "title",
  "most-viewed",
  "trending",
  "recently-added",
  "released",
  "topRated",
] as const;

const copyTags = (items: readonly Tag[]): Tag[] =>
  items.map(({ id, title }) => ({ id: String(id), title: String(title) }));

const itemId = (item: TaxonomyLike): string | undefined => {
  if (typeof item.id === "string" && item.id.trim()) return item.id.trim();
  if (typeof item.id === "number" && Number.isFinite(item.id)) return String(item.id);
  return undefined;
};

const itemTitle = (item: TaxonomyLike, fallback = ""): string => {
  const name = typeof item.name === "string" ? item.name : item.title;
  return typeof name === "string" && name.trim() ? name.trim() : fallback;
};

const toTag = (item: TaxonomyLike): Tag | undefined => {
  const id = itemId(item);
  if (!id) return undefined;
  return { id, title: itemTitle(item, id) };
};

const taxonomyTags = (
  items: readonly TaxonomyLike[] | undefined,
  fallback: readonly Tag[],
): Tag[] => {
  const converted = (items ?? []).map(toTag).filter((item): item is Tag => item !== undefined);
  return converted.length > 0 ? copyTags(converted) : copyTags(fallback);
};

const optionRecord = (items: readonly Tag[]): Set<string> => new Set(items.map(({ id }) => id));

const cleanRecord = (
  value: unknown,
  allowed: ReadonlySet<string>,
): Record<string, AtsumaruTaxonomyState> => {
  const result: Record<string, AtsumaruTaxonomyState> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return result;
  for (const [id, state] of Object.entries(value)) {
    if (allowed.has(id) && typeof state === "string" && stateValues.has(state as TriState)) {
      result[id] = state as TriState;
    }
  }
  return result;
};

const cleanArray = (value: unknown, allowed: ReadonlySet<string>): string[] => {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !allowed.has(entry) || seen.has(entry)) continue;
    seen.add(entry);
    result.push(entry);
  }
  return result;
};

const finiteInteger = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback;

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, Math.trunc(value)));

const readState = (metadata: AtsumaruSearchMetadata, key: string): unknown =>
  (metadata as Record<string, unknown>)[key];

const normalizeAdult = (value: unknown): AtsumaruAdultPolicy => {
  if (typeof value !== "string" || !adultValues.has(value as AtsumaruAdultPolicy)) return "safe";
  return value as AtsumaruAdultPolicy;
};

const normalizeGroupName = (value: unknown): string =>
  typeof value === "string" && value.trim() ? value.trim() : "Other tags";

interface NormalizedTagGroup {
  id: string;
  name: string;
  tags: Tag[];
}

const normalizeTagGroups = (taxonomy: AtsumaruSearchOptions): NormalizedTagGroup[] => {
  const raw = taxonomy as AtsumaruSearchTaxonomy;
  const groups: NormalizedTagGroup[] = [];
  const byId = new Map<string, NormalizedTagGroup>();
  const seenById = new Map<string, Set<string>>();
  const add = (id: string, name: string, items: readonly TaxonomyLike[]) => {
    if (items.length === 0) return;
    const safeId = encodePaperbackIdComponent(id);
    const existing = byId.get(safeId);
    if (existing) {
      const seen = seenById.get(safeId)!;
      for (const item of items) {
        const tag = toTag(item);
        if (tag && !seen.has(tag.id)) {
          existing.tags.push(tag);
          seen.add(tag.id);
        }
      }
      return;
    }
    const tags = items.map(toTag).filter((tag): tag is Tag => tag !== undefined);
    if (tags.length === 0) return;
    const group = { id: safeId, name, tags: copyTags(tags) };
    groups.push(group);
    byId.set(safeId, group);
    seenById.set(safeId, new Set(group.tags.map((tag) => tag.id)));
  };

  for (const group of raw.tagGroups ?? []) {
    const candidate = group as TaxonomyLike & { tags?: readonly TaxonomyLike[] };
    const id = itemId(candidate) ?? normalizeGroupName(candidate.name ?? candidate.title);
    const name = normalizeGroupName(candidate.name ?? candidate.title ?? id);
    add(id, name, candidate.tags ?? []);
  }

  const flatTags = raw.tags ?? [];
  for (const tag of flatTags) {
    const groupName = normalizeGroupName(tag.group);
    add(groupName, groupName, [tag]);
  }

  // A few API adapters expose only {group, name}; retain those filters without
  // turning them into a giant initial selector. IDs are stable names when none
  // were supplied by the endpoint.
  for (const value of raw.availableFilters ?? []) {
    if (!value || typeof value !== "object") continue;
    const candidate = value as Record<string, unknown>;
    const groupName = normalizeGroupName(candidate.group);
    const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
    if (!name) continue;
    add(groupName, groupName, [{ id: name, name }]);
  }

  return groups;
};

class AtsumaruTagGroupForm extends Form {
  private value: Record<string, AtsumaruTaxonomyState>;

  constructor(
    private readonly group: NormalizedTagGroup,
    initial: Record<string, AtsumaruTaxonomyState>,
    private readonly onChange: (
      group: NormalizedTagGroup,
      value: Record<string, AtsumaruTaxonomyState>,
    ) => Promise<void>,
  ) {
    super();
    this.value = cleanRecord(initial, optionRecord(group.tags));
  }

  override getSections() {
    return [
      Section(this.group.id, [
        TriStateSelectRow("tags", {
          title: this.group.name,
          subtitle: "Include or exclude tags.",
          layout: "flow",
          value: { ...this.value },
          items: copyTags(this.group.tags),
          allowExclusion: true,
          allowEmptySelection: true,
          onValueChange: Application.Selector(this as AtsumaruTagGroupForm, "handleTagGroupChange"),
        }),
      ]),
    ];
  }

  async handleTagGroupChange(value: Record<string, AtsumaruTaxonomyState>): Promise<void> {
    const allowed = optionRecord(this.group.tags);
    const next = cleanRecord(value, allowed);
    await this.onChange(this.group, { ...next });
    this.value = next;
  }
}

const selectedCount = (
  values: Record<string, AtsumaruTaxonomyState>,
  group: NormalizedTagGroup,
): number => group.tags.reduce((count, { id }) => count + (values[id] ? 1 : 0), 0);

export class AtsumaruAdvancedSearchForm extends AdvancedSearchForm {
  private readonly queryTitle: string;
  private readonly genresOptions: Tag[];
  private readonly typeOptions: Tag[];
  private readonly mediumOptions: Tag[];
  private readonly statusOptions: Tag[];
  private readonly contentRatingOptions: Tag[];
  private readonly tagGroups: NormalizedTagGroup[];
  private readonly tagGroupForms = new Map<string, AtsumaruTagGroupForm>();
  private readonly genreIds: Set<string>;
  private readonly typeIds: Set<string>;
  private readonly mediumIds: Set<string>;
  private readonly statusIds: Set<string>;
  private readonly contentRatingIds: Set<string>;
  private readonly tagIds: Set<string>;

  private genres: Record<string, AtsumaruTaxonomyState>;
  private tags: Record<string, AtsumaruTaxonomyState>;
  private types: string[];
  private mediums: string[];
  private statuses: string[];
  private contentRatings: string[];
  /** True when the user/query supplied a rating selection, including empty/all. */
  private contentRatingsExplicit: boolean;
  private adult: AtsumaruAdultPolicy;
  private yearsEnabled: boolean;
  private minYear: number;
  private maxYear: number;
  private chaptersEnabled: boolean;
  private minChapters: number;
  private officialTranslation: boolean;

  constructor(query: SearchQuery<AtsumaruSearchMetadata>, taxonomy: AtsumaruSearchOptions = {}) {
    super();
    this.queryTitle = query.title ?? "";
    const metadata = query.metadata ?? {};
    this.genresOptions = taxonomyTags(taxonomy.genres, GENRE_OPTIONS);
    this.typeOptions = taxonomyTags(taxonomy.types, TYPE_OPTIONS);
    this.mediumOptions = taxonomyTags(taxonomy.mediums, MEDIUM_OPTIONS);
    this.statusOptions = taxonomyTags(taxonomy.statuses, STATUS_OPTIONS);
    this.contentRatingOptions = taxonomyTags(taxonomy.contentRatings, CONTENT_RATING_OPTIONS);
    this.tagGroups = normalizeTagGroups(taxonomy);

    this.genreIds = optionRecord(this.genresOptions);
    this.typeIds = optionRecord(this.typeOptions);
    this.mediumIds = optionRecord(this.mediumOptions);
    this.statusIds = optionRecord(this.statusOptions);
    this.contentRatingIds = optionRecord(this.contentRatingOptions);
    this.tagIds = new Set(this.tagGroups.flatMap((group) => group.tags.map(({ id }) => id)));

    this.genres = cleanRecord(metadata.genres, this.genreIds);
    this.tags = cleanRecord(metadata.tags, this.tagIds);
    this.types = cleanArray(metadata.types, this.typeIds);
    this.mediums = cleanArray(metadata.mediums, this.mediumIds);
    this.statuses = cleanArray(metadata.statuses ?? readState(metadata, "status"), this.statusIds);
    this.adult = normalizeAdult(metadata.adultPolicy ?? metadata.adult);
    const rawContentRatings = metadata.contentRatings;
    const parsedContentRatings = cleanArray(rawContentRatings, this.contentRatingIds);
    const hasValidContentRatingArray =
      Array.isArray(rawContentRatings) &&
      (rawContentRatings.length === 0 || parsedContentRatings.length > 0);
    if (!hasValidContentRatingArray) {
      this.contentRatings = this.defaultContentRatings();
      this.contentRatingsExplicit = false;
    } else {
      this.contentRatings = parsedContentRatings;
      this.contentRatingsExplicit = true;
    }

    const range = this.readYearRange(metadata);
    this.yearsEnabled = range !== undefined;
    this.minYear = range?.[0] ?? YEAR_MIN;
    this.maxYear = range?.[1] ?? currentYear() + 1;

    this.minChapters = clamp(finiteInteger(metadata.minChapters, 0), 0, 9_999);
    this.chaptersEnabled = typeof metadata.minChapters === "number" && metadata.minChapters > 0;
    this.officialTranslation = metadata.officialTranslation === true;
    this.tags = this.boundedTags(this.tags);

    for (const group of this.tagGroups) {
      this.tagGroupForms.set(
        group.id,
        new AtsumaruTagGroupForm(group, this.tags, async (changedGroup, value) => {
          await this.handleTagGroupChange(changedGroup, value);
        }),
      );
    }
  }

  /**
   * Keep the visible implicit rating selection aligned with the catalog's
   * network semantics. The `safe` ID is retained for persisted compatibility;
   * it is the standard Atsumaru catalog, not an assertion that every rating is
   * absent from the result set.
   */
  private defaultContentRatings(): string[] {
    if (this.adult === "safe") {
      return standardRatings.filter((id) => this.contentRatingIds.has(id));
    }
    return this.contentRatingOptions.map(({ id }) => id);
  }

  private buildMetadata(
    genres: Record<string, AtsumaruTaxonomyState> = this.genres,
    tags: Record<string, AtsumaruTaxonomyState> = this.tags,
  ): AtsumaruSearchMetadata {
    const metadata: AtsumaruSearchMetadata = {};
    if (Object.keys(genres).length > 0) metadata.genres = { ...genres };
    if (Object.keys(tags).length > 0) metadata.tags = { ...tags };
    if (this.types.length > 0) metadata.types = [...this.types];
    if (this.mediums.length > 0) metadata.mediums = [...this.mediums];
    if (this.statuses.length > 0) metadata.statuses = [...this.statuses];
    if (this.contentRatingsExplicit) {
      metadata.contentRatings = [...this.contentRatings];
    }
    if (this.adult === "adult" || this.adult === "only") metadata.adult = "adult";
    else if (this.adult === "all") metadata.adult = "all";
    if (this.yearsEnabled) {
      const low = clamp(this.minYear, YEAR_MIN, currentYear() + 1);
      const high = clamp(this.maxYear, YEAR_MIN, currentYear() + 1);
      metadata.years = low <= high ? [low, high] : [high, low];
    }
    if (this.chaptersEnabled && this.minChapters > 0) {
      metadata.minChapters = clamp(this.minChapters, 0, 9_999);
    }
    if (this.officialTranslation) metadata.officialTranslation = true;
    return metadata;
  }

  private assertWithinSearchBudget(metadata: AtsumaruSearchMetadata): void {
    buildSearchUrl({ title: this.queryTitle, metadata }, undefined, 1);
    for (const id of SEARCH_BUDGET_SORTING_IDS) {
      buildSearchUrl({ title: this.queryTitle, metadata }, { id, label: id }, 1);
    }
  }

  private commitWithinSearchBudget(apply: () => void, rollback: () => void): void {
    apply();
    try {
      this.assertWithinSearchBudget(this.buildMetadata());
    } catch (error: unknown) {
      rollback();
      throw error;
    }
  }

  private boundedTags(
    value: Record<string, AtsumaruTaxonomyState>,
  ): Record<string, AtsumaruTaxonomyState> {
    const entries = Object.entries(value);
    let lower = 0;
    let upper = entries.length;
    while (lower < upper) {
      const count = Math.ceil((lower + upper) / 2);
      const candidate = Object.fromEntries(entries.slice(0, count)) as Record<
        string,
        AtsumaruTaxonomyState
      >;
      try {
        this.assertWithinSearchBudget(this.buildMetadata(this.genres, candidate));
        lower = count;
      } catch {
        upper = count - 1;
      }
    }
    return Object.fromEntries(entries.slice(0, lower)) as Record<string, AtsumaruTaxonomyState>;
  }

  private readYearRange(metadata: AtsumaruSearchMetadata): [number, number] | undefined {
    const rawYears = metadata.years;
    let lower: unknown;
    let upper: unknown;
    if (Array.isArray(rawYears) && rawYears.length > 0) {
      lower = rawYears[0];
      upper = rawYears[1] ?? rawYears[0];
    } else if (metadata.yearRange && typeof metadata.yearRange === "object") {
      lower = metadata.yearRange.from ?? metadata.yearRange.min;
      upper = metadata.yearRange.to ?? metadata.yearRange.max;
    } else {
      lower = metadata.yearFrom ?? metadata.releaseYearFrom;
      upper = metadata.yearTo ?? metadata.releaseYearTo;
    }
    if (lower === undefined && upper === undefined) return undefined;
    const min = clamp(finiteInteger(lower, YEAR_MIN), YEAR_MIN, currentYear() + 1);
    const max = clamp(finiteInteger(upper, currentYear() + 1), YEAR_MIN, currentYear() + 1);
    return min <= max ? [min, max] : [max, min];
  }

  override getSections() {
    const tagItems = this.tagGroups.map((group) => {
      const form = this.tagGroupForms.get(group.id);
      const count = selectedCount(this.tags, group);
      return NavigationRow(`tagGroup-${group.id}`, {
        title: group.name,
        value: count > 0 ? `${count} selected` : undefined,
        subtitle: `${count} selected · ${group.tags.length} tags`,
        form:
          form ??
          new AtsumaruTagGroupForm(group, this.tags, async (changedGroup, value) => {
            await this.handleTagGroupChange(changedGroup, value);
          }),
      });
    });

    return [
      Section("taxonomy", [
        TriStateSelectRow("genres", {
          title: "Genres",
          layout: "flow",
          value: { ...this.genres },
          items: copyTags(this.genresOptions),
          allowExclusion: true,
          allowEmptySelection: true,
          onValueChange: Application.Selector(
            this as AtsumaruAdvancedSearchForm,
            "handleGenresChange",
          ),
        }),
        SelectRow("types", {
          title: "Types",
          layout: "flow",
          value: [...this.types],
          items: copyTags(this.typeOptions),
          minItemCount: 0,
          maxItemCount: this.typeOptions.length,
          onValueChange: Application.Selector(
            this as AtsumaruAdvancedSearchForm,
            "handleTypesChange",
          ),
        }),
        SelectRow("mediums", {
          title: "Mediums",
          layout: "flow",
          value: [...this.mediums],
          items: copyTags(this.mediumOptions),
          minItemCount: 0,
          maxItemCount: this.mediumOptions.length,
          onValueChange: Application.Selector(
            this as AtsumaruAdvancedSearchForm,
            "handleMediumsChange",
          ),
        }),
        SelectRow("statuses", {
          title: "Status",
          layout: "flow",
          value: [...this.statuses],
          items: copyTags(this.statusOptions),
          minItemCount: 0,
          maxItemCount: this.statusOptions.length,
          onValueChange: Application.Selector(
            this as AtsumaruAdvancedSearchForm,
            "handleStatusesChange",
          ),
        }),
      ]),
      Section("content", [
        SelectRow("adult", {
          title: "Catalog",
          subtitle:
            "Standard catalog excludes Atsumaru’s adult/Pornographic catalog; content ratings provide stricter control.",
          layout: "list",
          value: [this.adult === "only" ? "adult" : this.adult],
          items: copyTags(ADULT_CATALOG_OPTIONS),
          minItemCount: 1,
          maxItemCount: 1,
          onValueChange: Application.Selector(
            this as AtsumaruAdvancedSearchForm,
            "handleAdultCatalogChange",
          ),
        }),
        SelectRow("contentRatings", {
          title: "Content ratings",
          layout: "flow",
          value: [...this.contentRatings],
          items: copyTags(this.contentRatingOptions),
          minItemCount: 0,
          maxItemCount: this.contentRatingOptions.length,
          onValueChange: Application.Selector(
            this as AtsumaruAdvancedSearchForm,
            "handleContentRatingsChange",
          ),
        }),
      ]),
      Section("release", [
        ToggleRow("enableYears", {
          title: "Limit release years",
          subtitle: "Include titles released within an inclusive year range.",
          value: this.yearsEnabled,
          onValueChange: Application.Selector(
            this as AtsumaruAdvancedSearchForm,
            "handleEnableYearsChange",
          ),
        }),
        StepperRow("minYear", {
          title: "From year",
          value: this.minYear,
          minValue: YEAR_MIN,
          maxValue: currentYear() + 1,
          stepValue: 1,
          loopOver: false,
          isHidden: !this.yearsEnabled,
          onValueChange: Application.Selector(
            this as AtsumaruAdvancedSearchForm,
            "handleMinYearChange",
          ),
        }),
        StepperRow("maxYear", {
          title: "To year",
          value: this.maxYear,
          minValue: YEAR_MIN,
          maxValue: currentYear() + 1,
          stepValue: 1,
          loopOver: false,
          isHidden: !this.yearsEnabled,
          onValueChange: Application.Selector(
            this as AtsumaruAdvancedSearchForm,
            "handleMaxYearChange",
          ),
        }),
      ]),
      Section("chapters", [
        ToggleRow("enableChapters", {
          title: "Limit minimum chapters",
          subtitle: "Include titles with at least this many chapters.",
          value: this.chaptersEnabled,
          onValueChange: Application.Selector(
            this as AtsumaruAdvancedSearchForm,
            "handleEnableChaptersChange",
          ),
        }),
        StepperRow("minChapters", {
          title: "Minimum chapters",
          value: this.minChapters,
          minValue: 0,
          maxValue: 9_999,
          stepValue: 1,
          loopOver: false,
          isHidden: !this.chaptersEnabled,
          onValueChange: Application.Selector(
            this as AtsumaruAdvancedSearchForm,
            "handleMinChaptersChange",
          ),
        }),
      ]),
      Section("availability", [
        ToggleRow("officialTranslation", {
          title: "Official translation only",
          value: this.officialTranslation,
          onValueChange: Application.Selector(
            this as AtsumaruAdvancedSearchForm,
            "handleOfficialTranslationChange",
          ),
        }),
      ]),
      ...(tagItems.length > 0 ? [Section("tags", tagItems)] : []),
    ];
  }

  async handleGenresChange(value: Record<string, AtsumaruTaxonomyState>): Promise<void> {
    const next = cleanRecord(value, this.genreIds);
    this.assertWithinSearchBudget(this.buildMetadata(next, this.tags));
    this.genres = next;
  }

  async handleTypesChange(value: string[]): Promise<void> {
    const previous = this.types;
    const next = cleanArray(value, this.typeIds);
    this.commitWithinSearchBudget(
      () => {
        this.types = next;
      },
      () => {
        this.types = previous;
      },
    );
  }

  async handleMediumsChange(value: string[]): Promise<void> {
    const previous = this.mediums;
    const next = cleanArray(value, this.mediumIds);
    this.commitWithinSearchBudget(
      () => {
        this.mediums = next;
      },
      () => {
        this.mediums = previous;
      },
    );
  }

  async handleStatusesChange(value: string[]): Promise<void> {
    const previous = this.statuses;
    const next = cleanArray(value, this.statusIds);
    this.commitWithinSearchBudget(
      () => {
        this.statuses = next;
      },
      () => {
        this.statuses = previous;
      },
    );
  }

  async handleStatusChange(value: string[]): Promise<void> {
    await this.handleStatusesChange(value);
  }

  async handleAdultCatalogChange(value: string[]): Promise<void> {
    const previous = this.adult;
    const previousRatings = [...this.contentRatings];
    const previousRatingsExplicit = this.contentRatingsExplicit;
    const next = normalizeAdult(value[0]);
    this.commitWithinSearchBudget(
      () => {
        this.adult = next;
        if (!this.contentRatingsExplicit) this.contentRatings = this.defaultContentRatings();
      },
      () => {
        this.adult = previous;
        this.contentRatings = previousRatings;
        this.contentRatingsExplicit = previousRatingsExplicit;
      },
    );
    this.reloadForm();
  }

  async handleAdultChange(value: string[]): Promise<void> {
    await this.handleAdultCatalogChange(value);
  }

  async handleContentRatingsChange(value: string[]): Promise<void> {
    const previous = [...this.contentRatings];
    const previousExplicit = this.contentRatingsExplicit;
    const next = cleanArray(value, this.contentRatingIds);
    this.commitWithinSearchBudget(
      () => {
        this.contentRatings = next;
        this.contentRatingsExplicit = true;
      },
      () => {
        this.contentRatings = previous;
        this.contentRatingsExplicit = previousExplicit;
      },
    );
  }

  async handleEnableYearsChange(value: boolean): Promise<void> {
    const previous = this.yearsEnabled;
    this.commitWithinSearchBudget(
      () => {
        this.yearsEnabled = value;
      },
      () => {
        this.yearsEnabled = previous;
      },
    );
    this.reloadForm();
  }

  async handleMinYearChange(value: number): Promise<void> {
    const previous = this.minYear;
    const next = clamp(value, YEAR_MIN, currentYear() + 1);
    this.commitWithinSearchBudget(
      () => {
        this.minYear = next;
      },
      () => {
        this.minYear = previous;
      },
    );
  }

  async handleMaxYearChange(value: number): Promise<void> {
    const previous = this.maxYear;
    const next = clamp(value, YEAR_MIN, currentYear() + 1);
    this.commitWithinSearchBudget(
      () => {
        this.maxYear = next;
      },
      () => {
        this.maxYear = previous;
      },
    );
  }

  async handleEnableChaptersChange(value: boolean): Promise<void> {
    const previous = this.chaptersEnabled;
    this.commitWithinSearchBudget(
      () => {
        this.chaptersEnabled = value;
      },
      () => {
        this.chaptersEnabled = previous;
      },
    );
    this.reloadForm();
  }

  async handleMinChaptersChange(value: number): Promise<void> {
    const previous = this.minChapters;
    const next = clamp(value, 0, 9_999);
    this.commitWithinSearchBudget(
      () => {
        this.minChapters = next;
      },
      () => {
        this.minChapters = previous;
      },
    );
  }

  async handleOfficialTranslationChange(value: boolean): Promise<void> {
    const previous = this.officialTranslation;
    this.commitWithinSearchBudget(
      () => {
        this.officialTranslation = value;
      },
      () => {
        this.officialTranslation = previous;
      },
    );
  }

  async handleTagGroupChange(
    group: NormalizedTagGroup,
    value: Record<string, AtsumaruTaxonomyState>,
  ): Promise<void> {
    if (!this.tagGroups.includes(group)) throw new Error("Atsumaru tag group is invalid.");
    const groupIds = new Set(group.tags.map(({ id }) => id));
    const merged: Record<string, AtsumaruTaxonomyState> = {};
    for (const [id, state] of Object.entries(this.tags)) {
      if (!groupIds.has(id)) merged[id] = state;
    }
    Object.assign(merged, cleanRecord(value, groupIds));
    this.assertWithinSearchBudget(this.buildMetadata(this.genres, merged));
    this.tags = merged;
    this.reloadForm();
  }

  override getSearchQueryMetadata(): AtsumaruSearchMetadata {
    const metadata = this.buildMetadata();
    this.assertWithinSearchBudget(metadata);
    return metadata;
  }
}

export type AtsumaruTagGroupFormContract = Form & {
  handleTagGroupChange(value: Record<string, AtsumaruTaxonomyState>): Promise<void>;
};
