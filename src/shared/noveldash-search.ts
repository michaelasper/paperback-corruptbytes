import {
  AdvancedSearchForm,
  Section,
  SelectRow,
  StepperRow,
  ToggleRow,
  TriStateSelectRow,
  type SearchQuery,
  type Tag,
} from "@paperback/types";

import type { NovelDashSearchMetadata } from "./noveldash-models.js";

export const NOVELDASH_STATUS_OPTIONS: Tag[] = [
  { id: "ONGOING", title: "Ongoing" },
  { id: "COMPLETED", title: "Completed" },
  { id: "HIATUS", title: "Hiatus" },
  { id: "DROPPED", title: "Dropped" },
  { id: "DISCONTINUED", title: "Discontinued" },
  { id: "UPCOMING", title: "Upcoming" },
];

export const NOVELDASH_TYPE_OPTIONS: Tag[] = [
  { id: "MANHWA", title: "Manhwa" },
  { id: "MANGA", title: "Manga" },
  { id: "MANHUA", title: "Manhua" },
  { id: "WEBTOON", title: "Webtoon" },
  { id: "COMIC", title: "Comic" },
  { id: "NOVEL", title: "Novel" },
  { id: "WEB_NOVEL", title: "Web novel" },
  { id: "LIGHT_NOVEL", title: "Light novel" },
  { id: "PUBLISHED_NOVEL", title: "Published novel" },
  { id: "ORIGINAL_FICTION", title: "Original fiction" },
  { id: "FANFICTION", title: "Fanfiction" },
  { id: "ONE_SHOT", title: "One shot" },
];

export const NOVELDASH_ORIGIN_OPTIONS: Tag[] = [
  { id: "KOREAN", title: "Korean" },
  { id: "JAPANESE", title: "Japanese" },
  { id: "CHINESE", title: "Chinese" },
  { id: "OTHER", title: "Other" },
];

const bounded = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(100_000, Math.trunc(value)))
    : fallback;

export class NovelDashAdvancedSearchForm extends AdvancedSearchForm {
  private genres: Record<string, "included" | "excluded">;
  private statuses: string[];
  private types: string[];
  private origins: string[];
  private chapterRangeEnabled: boolean;
  private minimumChapters: number;
  private maximumChapters: number;
  private onSale: boolean;

  constructor(
    searchQuery: SearchQuery<NovelDashSearchMetadata>,
    private readonly genreOptions: Tag[],
  ) {
    super();
    const metadata = searchQuery.metadata ?? {};
    this.genres = { ...metadata.genres };
    this.statuses = [...(metadata.statuses ?? [])];
    this.types = [...(metadata.types ?? [])];
    this.origins = [...(metadata.origins ?? [])];
    this.chapterRangeEnabled = metadata.chapterRangeEnabled === true;
    this.minimumChapters = bounded(metadata.minimumChapters, 0);
    this.maximumChapters = bounded(metadata.maximumChapters, 1_000);
    this.onSale = metadata.onSale === true;
  }

  override getSections() {
    return [
      Section("format", [
        SelectRow("types", {
          title: "Format",
          layout: "flow",
          value: this.types,
          items: NOVELDASH_TYPE_OPTIONS,
          minItemCount: 0,
          maxItemCount: NOVELDASH_TYPE_OPTIONS.length,
          onValueChange: Application.Selector(
            this as NovelDashAdvancedSearchForm,
            "handleTypesChange",
          ),
        }),
        SelectRow("statuses", {
          title: "Status",
          layout: "flow",
          value: this.statuses,
          items: NOVELDASH_STATUS_OPTIONS,
          minItemCount: 0,
          maxItemCount: NOVELDASH_STATUS_OPTIONS.length,
          onValueChange: Application.Selector(
            this as NovelDashAdvancedSearchForm,
            "handleStatusesChange",
          ),
        }),
        SelectRow("origins", {
          title: "Origin",
          layout: "flow",
          value: this.origins,
          items: NOVELDASH_ORIGIN_OPTIONS,
          minItemCount: 0,
          maxItemCount: NOVELDASH_ORIGIN_OPTIONS.length,
          onValueChange: Application.Selector(
            this as NovelDashAdvancedSearchForm,
            "handleOriginsChange",
          ),
        }),
      ]),
      ...(this.genreOptions.length > 0
        ? [
            Section("genres", [
              TriStateSelectRow("genres", {
                title: "Genres",
                layout: "flow",
                value: this.genres,
                items: this.genreOptions,
                allowExclusion: true,
                allowEmptySelection: true,
                onValueChange: Application.Selector(
                  this as NovelDashAdvancedSearchForm,
                  "handleGenresChange",
                ),
              }),
            ]),
          ]
        : []),
      Section("chapters", [
        ToggleRow("chapter_range", {
          title: "Limit chapter count",
          value: this.chapterRangeEnabled,
          onValueChange: Application.Selector(
            this as NovelDashAdvancedSearchForm,
            "handleChapterRangeChange",
          ),
        }),
        StepperRow("minimum_chapters", {
          title: "Minimum chapters",
          value: this.minimumChapters,
          minValue: 0,
          maxValue: 100_000,
          stepValue: 10,
          loopOver: false,
          isHidden: !this.chapterRangeEnabled,
          onValueChange: Application.Selector(
            this as NovelDashAdvancedSearchForm,
            "handleMinimumChaptersChange",
          ),
        }),
        StepperRow("maximum_chapters", {
          title: "Maximum chapters",
          value: this.maximumChapters,
          minValue: 0,
          maxValue: 100_000,
          stepValue: 10,
          loopOver: false,
          isHidden: !this.chapterRangeEnabled,
          onValueChange: Application.Selector(
            this as NovelDashAdvancedSearchForm,
            "handleMaximumChaptersChange",
          ),
        }),
        ToggleRow("on_sale", {
          title: "On sale only",
          subtitle: "Show series with an active chapter discount.",
          value: this.onSale,
          onValueChange: Application.Selector(
            this as NovelDashAdvancedSearchForm,
            "handleOnSaleChange",
          ),
        }),
      ]),
    ];
  }

  async handleGenresChange(value: Record<string, "included" | "excluded">): Promise<void> {
    this.genres = { ...value };
  }

  async handleStatusesChange(value: string[]): Promise<void> {
    this.statuses = [...value];
  }

  async handleTypesChange(value: string[]): Promise<void> {
    this.types = [...value];
  }

  async handleOriginsChange(value: string[]): Promise<void> {
    this.origins = [...value];
  }

  async handleChapterRangeChange(value: boolean): Promise<void> {
    this.chapterRangeEnabled = value;
    this.reloadForm();
  }

  async handleMinimumChaptersChange(value: number): Promise<void> {
    this.minimumChapters = bounded(value, 0);
  }

  async handleMaximumChaptersChange(value: number): Promise<void> {
    this.maximumChapters = bounded(value, 1_000);
  }

  async handleOnSaleChange(value: boolean): Promise<void> {
    this.onSale = value;
  }

  override getSearchQueryMetadata(): NovelDashSearchMetadata {
    const minimumChapters = Math.min(this.minimumChapters, this.maximumChapters);
    const maximumChapters = Math.max(this.minimumChapters, this.maximumChapters);
    return {
      ...(Object.keys(this.genres).length > 0 && { genres: { ...this.genres } }),
      ...(this.statuses.length > 0 && { statuses: [...this.statuses] }),
      ...(this.types.length > 0 && { types: [...this.types] }),
      ...(this.origins.length > 0 && { origins: [...this.origins] }),
      ...(this.chapterRangeEnabled && {
        chapterRangeEnabled: true,
        minimumChapters,
        maximumChapters,
      }),
      ...(this.onSale && { onSale: true }),
    };
  }
}
