import {
  AdvancedSearchForm,
  Section,
  SelectRow,
  TriStateSelectRow,
  type SearchQuery,
  type Tag,
} from "@paperback/types";

import type { SearchMetadata } from "./network.js";

export const STATUS_OPTIONS: Tag[] = [
  { id: "ONGOING", title: "Ongoing" },
  { id: "COMPLETED", title: "Completed" },
  { id: "CANCELLED", title: "Cancelled" },
  { id: "DROPPED", title: "Dropped" },
  { id: "HIATUS", title: "Hiatus" },
  { id: "COMING_SOON", title: "Coming soon" },
  { id: "MASS_RELEASED", title: "Mass released" },
];

export const TYPE_OPTIONS: Tag[] = [
  { id: "MANGA", title: "Manga" },
  { id: "MANHUA", title: "Manhua" },
  { id: "MANHWA", title: "Manhwa" },
  { id: "NOVEL", title: "Novel" },
  { id: "RUSSIAN", title: "Russian" },
  { id: "SPANISH", title: "Spanish" },
];

export const SORT_DIRECTION_OPTIONS: Tag[] = [
  { id: "desc", title: "Descending" },
  { id: "asc", title: "Ascending" },
];

export class VortexAdvancedSearchForm extends AdvancedSearchForm {
  private status: string[];
  private type: string[];
  private direction: string[];
  private genres: Record<string, "included" | "excluded">;

  constructor(
    searchQuery: SearchQuery<SearchMetadata>,
    private readonly genreOptions: Tag[],
  ) {
    super();
    const metadata = searchQuery.metadata ?? {};
    this.status = [...(metadata.status ?? [])];
    this.type = [...(metadata.type ?? [])];
    this.direction = [...(metadata.direction ?? [])];
    this.genres = { ...metadata.genres };
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
            this as VortexAdvancedSearchForm,
            "handleStatusChange",
          ),
        }),
      ]),
      Section("type", [
        SelectRow("type", {
          title: "Type",
          layout: "flow",
          value: this.type,
          items: TYPE_OPTIONS,
          minItemCount: 0,
          maxItemCount: 1,
          onValueChange: Application.Selector(this as VortexAdvancedSearchForm, "handleTypeChange"),
        }),
      ]),
      Section("direction", [
        SelectRow("direction", {
          title: "Sort direction",
          layout: "flow",
          value: this.direction,
          items: SORT_DIRECTION_OPTIONS,
          minItemCount: 0,
          maxItemCount: 1,
          onValueChange: Application.Selector(
            this as VortexAdvancedSearchForm,
            "handleDirectionChange",
          ),
        }),
      ]),
    ];

    if (this.genreOptions.length > 0) {
      sections.push(
        Section("genres", [
          TriStateSelectRow("genres", {
            title: "Genres",
            layout: "flow",
            value: this.genres,
            items: this.genreOptions,
            allowExclusion: true,
            allowEmptySelection: true,
            onValueChange: Application.Selector(
              this as VortexAdvancedSearchForm,
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

  async handleDirectionChange(value: string[]): Promise<void> {
    this.direction = [...value];
  }

  async handleGenresChange(value: Record<string, "included" | "excluded">): Promise<void> {
    this.genres = { ...value };
  }

  override getSearchQueryMetadata(): SearchMetadata {
    return {
      ...(this.status.length > 0 && { status: this.status }),
      ...(this.type.length > 0 && { type: this.type }),
      ...(this.direction.length > 0 && { direction: this.direction }),
      ...(Object.keys(this.genres).length > 0 && { genres: this.genres }),
    };
  }
}
