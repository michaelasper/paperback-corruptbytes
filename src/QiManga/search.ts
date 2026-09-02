import {
  AdvancedSearchForm,
  Section,
  SelectRow,
  type SearchQuery,
  type Tag,
} from "@paperback/types";

import type { QiMangaSearchMetadata } from "./models.js";
import { hasTitleSearchQuery } from "./network.js";

// Match the public Qi Manga filter control exactly. Backend-only values such as
// CANCELLED and MASS_RELEASED remain displayable but are not user-selectable.
export const STATUS_OPTIONS: Tag[] = [
  { id: "ONGOING", title: "Ongoing" },
  { id: "COMPLETED", title: "Completed" },
  { id: "HIATUS", title: "Hiatus" },
  { id: "DROPPED", title: "Dropped" },
];

export const TYPE_OPTIONS: Tag[] = [
  { id: "MANGA", title: "Manga" },
  { id: "MANHWA", title: "Manhwa" },
  { id: "MANHUA", title: "Manhua" },
  { id: "NOVEL", title: "Novel" },
];

const selected = (value: unknown, options: readonly Tag[]): string[] =>
  typeof value === "string" && value.length <= 256 && options.some((option) => option.id === value)
    ? [value]
    : [];

const selectedFromChange = (value: unknown, options: readonly Tag[]): string[] => {
  try {
    return Array.isArray(value) && value.length === 1 ? selected(value[0], options) : [];
  } catch {
    return [];
  }
};

export class QiMangaAdvancedSearchForm extends AdvancedSearchForm {
  private readonly genreOptions: Tag[];
  private readonly titleSearch: boolean;
  private genre: string[];
  private status: string[];
  private type: string[];

  constructor(query: SearchQuery<QiMangaSearchMetadata>, genreOptions: Tag[]) {
    super();
    this.genreOptions = genreOptions.map((option) => ({ ...option }));
    this.titleSearch = hasTitleSearchQuery(query.title);
    const metadata = query.metadata ?? {};
    this.genre = selected(metadata.genre, this.genreOptions);
    this.status = selected(metadata.status, STATUS_OPTIONS);
    this.type = selected(metadata.type, TYPE_OPTIONS);
  }

  override getSections() {
    if (this.titleSearch) {
      return [
        Section(
          {
            id: "title-search",
            footer:
              "Qi Manga's title-search endpoint cannot combine genre, status, format, or sorting. Clear the title to browse with those controls.",
          },
          [],
        ),
      ];
    }

    return [
      Section(
        {
          id: "genres",
          footer:
            "Genre, status, format, and sorting apply when browsing without a title. " +
            "Qi Manga's title-search endpoint does not support combining those controls.",
        },
        [
          SelectRow("genre", {
            title: "Genre",
            layout: "list",
            value: [...this.genre],
            items: this.genreOptions.map((option) => ({ ...option })),
            minItemCount: 0,
            maxItemCount: 1,
            onValueChange: Application.Selector(
              this as QiMangaAdvancedSearchForm,
              "handleGenreChange",
            ),
          }),
        ],
      ),
      Section("series", [
        SelectRow("status", {
          title: "Status",
          layout: "flow",
          value: [...this.status],
          items: STATUS_OPTIONS.map((option) => ({ ...option })),
          minItemCount: 0,
          maxItemCount: 1,
          onValueChange: Application.Selector(
            this as QiMangaAdvancedSearchForm,
            "handleStatusChange",
          ),
        }),
        SelectRow("type", {
          title: "Format",
          layout: "flow",
          value: [...this.type],
          items: TYPE_OPTIONS.map((option) => ({ ...option })),
          minItemCount: 0,
          maxItemCount: 1,
          onValueChange: Application.Selector(
            this as QiMangaAdvancedSearchForm,
            "handleTypeChange",
          ),
        }),
      ]),
    ];
  }

  async handleGenreChange(value: string[]): Promise<void> {
    this.genre = selectedFromChange(value, this.genreOptions);
  }

  async handleStatusChange(value: string[]): Promise<void> {
    this.status = selectedFromChange(value, STATUS_OPTIONS);
  }

  async handleTypeChange(value: string[]): Promise<void> {
    this.type = selectedFromChange(value, TYPE_OPTIONS);
  }

  override getSearchQueryMetadata(): QiMangaSearchMetadata {
    if (this.titleSearch) return {};
    return {
      ...(this.genre[0] && { genre: this.genre[0] }),
      ...(this.status[0] && { status: this.status[0] }),
      ...(this.type[0] && { type: this.type[0] }),
    };
  }
}
