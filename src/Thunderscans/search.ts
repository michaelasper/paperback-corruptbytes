import {
  AdvancedSearchForm,
  Section,
  SelectRow,
  type SearchQuery,
  type Tag,
} from "@paperback/types";

import type { ThunderSearchMetadata } from "./models.js";

export const STATUS_OPTIONS: Tag[] = [
  { id: "ongoing", title: "Ongoing" },
  { id: "completed", title: "Completed" },
  { id: "hiatus", title: "Hiatus" },
];

export const TYPE_OPTIONS: Tag[] = [
  { id: "manga", title: "Manga" },
  { id: "manhwa", title: "Manhwa" },
  { id: "manhua", title: "Manhua" },
  { id: "comic", title: "Comic" },
  { id: "novel", title: "Novel" },
];

export class ThunderAdvancedSearchForm extends AdvancedSearchForm {
  private status: string[];
  private type: string[];
  private genres: string[];

  constructor(
    searchQuery: SearchQuery<ThunderSearchMetadata>,
    private readonly genreOptions: Tag[],
  ) {
    super();
    this.status = [...(searchQuery.metadata?.status ?? [])];
    this.type = [...(searchQuery.metadata?.type ?? [])];
    this.genres = Object.entries(searchQuery.metadata?.genres ?? {})
      .filter(([, state]) => state === "included")
      .map(([id]) => id)
      .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
  }

  override getSections() {
    const sections = [
      Section("status", [
        SelectRow("status", {
          title: "Status",
          layout: "flow",
          value: this.status,
          items: STATUS_OPTIONS,
          minItemCount: 0,
          maxItemCount: 1,
          onValueChange: Application.Selector(
            this as ThunderAdvancedSearchForm,
            "handleStatusChange",
          ),
        }),
      ]),
      Section("type", [
        SelectRow("type", {
          title: "Format",
          layout: "flow",
          value: this.type,
          items: TYPE_OPTIONS,
          minItemCount: 0,
          maxItemCount: 1,
          onValueChange: Application.Selector(
            this as ThunderAdvancedSearchForm,
            "handleTypeChange",
          ),
        }),
      ]),
    ];

    if (this.genreOptions.length > 0) {
      sections.push(
        Section("genres", [
          SelectRow("genres", {
            title: "Genres",
            layout: "flow",
            value: this.genres,
            items: this.genreOptions,
            minItemCount: 0,
            maxItemCount: this.genreOptions.length,
            onValueChange: Application.Selector(
              this as ThunderAdvancedSearchForm,
              "handleGenresChange",
            ),
          }),
        ]),
      );
    }
    return sections;
  }

  async handleStatusChange(value: string[]): Promise<void> {
    this.status = [...value];
  }

  async handleTypeChange(value: string[]): Promise<void> {
    this.type = [...value];
  }

  async handleGenresChange(value: string[]): Promise<void> {
    this.genres = [...value].sort((left, right) =>
      left.localeCompare(right, undefined, { numeric: true }),
    );
  }

  override getSearchQueryMetadata(): ThunderSearchMetadata {
    return {
      ...(this.status.length > 0 && { status: [...this.status] }),
      ...(this.type.length > 0 && { type: [...this.type] }),
      ...(this.genres.length > 0 && {
        genres: Object.fromEntries(this.genres.map((id) => [id, "included" as const])),
      }),
    };
  }
}
