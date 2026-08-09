import {
  AdvancedSearchForm,
  InputRow,
  LabelRow,
  Section,
  SelectRow,
  StepperRow,
  ToggleRow,
  TriStateSelectRow,
  type SearchQuery,
  type Tag,
} from "@paperback/types";

import type { MgekoSearchMetadata } from "./models.js";

export const STATUS_OPTIONS: Tag[] = [
  { id: "ongoing", title: "Ongoing" },
  { id: "completed", title: "Completed" },
  { id: "hiatus", title: "Hiatus" },
];

export const TYPE_OPTIONS: Tag[] = [
  { id: "manga", title: "Manga" },
  { id: "manhwa", title: "Manhwa" },
  { id: "manhua", title: "Manhua" },
  { id: "webtoon", title: "Webtoon" },
];

const finite = (value: number | undefined, fallback: number): number =>
  value !== undefined && Number.isFinite(value) ? value : fallback;

export class MgekoAdvancedSearchForm extends AdvancedSearchForm {
  private genres: Record<string, "included" | "excluded">;
  private status: string[];
  private type: string[];
  private tags: string;
  private setChapterCount: boolean;
  private minChapters: number;
  private maxChapters: number;
  private minRating: number;
  private onlyCompleted: boolean;
  private onlyTranslated: boolean;
  private hideOnBreak: boolean;

  constructor(
    query: SearchQuery<MgekoSearchMetadata>,
    private readonly genreOptions: Tag[],
  ) {
    super();
    const metadata = query.metadata ?? {};
    this.genres = { ...metadata.genres };
    this.status = [...(metadata.status ?? [])];
    this.type = [...(metadata.type ?? [])];
    this.tags = metadata.tags ?? "";
    this.setChapterCount = metadata.setChapterCount ?? false;
    this.minChapters = finite(metadata.minChapters, 0);
    this.maxChapters = finite(metadata.maxChapters, 9_999);
    this.minRating = finite(metadata.minRating, 0);
    this.onlyCompleted = metadata.onlyCompleted ?? false;
    this.onlyTranslated = metadata.onlyTranslated ?? false;
    this.hideOnBreak = metadata.hideOnBreak ?? false;
  }

  override getSections() {
    return [
      Section("genres", [
        TriStateSelectRow("genres", {
          title: "Genres",
          layout: "flow",
          value: this.genres,
          items: this.genreOptions,
          allowExclusion: true,
          allowEmptySelection: true,
          onValueChange: Application.Selector(
            this as MgekoAdvancedSearchForm,
            "handleGenresChange",
          ),
        }),
      ]),
      Section("series", [
        SelectRow("status", {
          title: "Status",
          layout: "flow",
          value: this.status,
          items: STATUS_OPTIONS,
          minItemCount: 0,
          maxItemCount: 1,
          onValueChange: Application.Selector(
            this as MgekoAdvancedSearchForm,
            "handleStatusChange",
          ),
        }),
        SelectRow("type", {
          title: "Format",
          layout: "flow",
          value: this.type,
          items: TYPE_OPTIONS,
          minItemCount: 0,
          maxItemCount: 1,
          onValueChange: Application.Selector(this as MgekoAdvancedSearchForm, "handleTypeChange"),
        }),
      ]),
      Section("chapters", [
        ToggleRow("setChapterCount", {
          title: "Limit chapter count",
          subtitle: "Include only series within a chapter-count range.",
          value: this.setChapterCount,
          onValueChange: Application.Selector(
            this as MgekoAdvancedSearchForm,
            "handleSetChapterCountChange",
          ),
        }),
        StepperRow("minChapters", {
          title: "Minimum chapters",
          value: this.minChapters,
          minValue: 0,
          maxValue: 9_999,
          stepValue: 5,
          loopOver: false,
          isHidden: !this.setChapterCount,
          onValueChange: Application.Selector(
            this as MgekoAdvancedSearchForm,
            "handleMinChaptersChange",
          ),
        }),
        StepperRow("maxChapters", {
          title: "Maximum chapters",
          value: this.maxChapters,
          minValue: 0,
          maxValue: 9_999,
          stepValue: 5,
          loopOver: false,
          isHidden: !this.setChapterCount,
          onValueChange: Application.Selector(
            this as MgekoAdvancedSearchForm,
            "handleMaxChaptersChange",
          ),
        }),
      ]),
      Section("rating", [
        StepperRow("minRating", {
          title: "Minimum rating",
          subtitle: "Set to 0 to include unrated series.",
          value: this.minRating,
          minValue: 0,
          maxValue: 5,
          stepValue: 0.1,
          loopOver: false,
          onValueChange: Application.Selector(
            this as MgekoAdvancedSearchForm,
            "handleMinRatingChange",
          ),
        }),
      ]),
      Section("tags", [
        LabelRow("tagsHelp", {
          title: "Tag slugs",
          subtitle: "Separate multiple site tag slugs with commas.",
        }),
        InputRow("tags", {
          title: "Tags",
          value: this.tags,
          onValueChange: Application.Selector(this as MgekoAdvancedSearchForm, "handleTagsChange"),
        }),
      ]),
      Section("availability", [
        ToggleRow("onlyCompleted", {
          title: "Completed translations only",
          value: this.onlyCompleted,
          onValueChange: Application.Selector(
            this as MgekoAdvancedSearchForm,
            "handleOnlyCompletedChange",
          ),
        }),
        ToggleRow("onlyTranslated", {
          title: "Translated chapters only",
          value: this.onlyTranslated,
          onValueChange: Application.Selector(
            this as MgekoAdvancedSearchForm,
            "handleOnlyTranslatedChange",
          ),
        }),
        ToggleRow("hideOnBreak", {
          title: "Hide series on break",
          value: this.hideOnBreak,
          onValueChange: Application.Selector(
            this as MgekoAdvancedSearchForm,
            "handleHideOnBreakChange",
          ),
        }),
      ]),
    ];
  }

  async handleGenresChange(value: Record<string, "included" | "excluded">): Promise<void> {
    this.genres = { ...value };
  }

  async handleStatusChange(value: string[]): Promise<void> {
    this.status = [...value];
  }

  async handleTypeChange(value: string[]): Promise<void> {
    this.type = [...value];
  }

  async handleTagsChange(value: string): Promise<void> {
    this.tags = value;
  }

  async handleSetChapterCountChange(value: boolean): Promise<void> {
    this.setChapterCount = value;
    this.reloadForm();
  }

  async handleMinChaptersChange(value: number): Promise<void> {
    this.minChapters = value;
  }

  async handleMaxChaptersChange(value: number): Promise<void> {
    this.maxChapters = value;
  }

  async handleMinRatingChange(value: number): Promise<void> {
    this.minRating = value;
  }

  async handleOnlyCompletedChange(value: boolean): Promise<void> {
    this.onlyCompleted = value;
  }

  async handleOnlyTranslatedChange(value: boolean): Promise<void> {
    this.onlyTranslated = value;
  }

  async handleHideOnBreakChange(value: boolean): Promise<void> {
    this.hideOnBreak = value;
  }

  override getSearchQueryMetadata(): MgekoSearchMetadata {
    const min = Math.max(0, Math.min(9_999, Math.trunc(this.minChapters)));
    const max = Math.max(0, Math.min(9_999, Math.trunc(this.maxChapters)));
    const tags = this.tags
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean)
      .join(",");
    return {
      ...(Object.keys(this.genres).length > 0 && { genres: { ...this.genres } }),
      ...(this.status.length > 0 && { status: [...this.status] }),
      ...(this.type.length > 0 && { type: [...this.type] }),
      ...(tags && { tags }),
      ...(this.setChapterCount && {
        setChapterCount: true,
        minChapters: Math.min(min, max),
        maxChapters: Math.max(min, max),
      }),
      ...(this.minRating > 0 && {
        minRating: Math.min(5, Math.max(0, Number(this.minRating.toFixed(1)))),
      }),
      ...(this.onlyCompleted && { onlyCompleted: true }),
      ...(this.onlyTranslated && { onlyTranslated: true }),
      ...(this.hideOnBreak && { hideOnBreak: true }),
    };
  }
}
