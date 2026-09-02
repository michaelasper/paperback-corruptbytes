import {
  AdvancedSearchForm,
  Section,
  SelectRow,
  type SearchQuery,
  type Tag,
} from "@paperback/types";

import type { QiMangaSearchMetadata } from "./models.js";

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

const selected = (value: string | undefined, options: readonly Tag[]): string[] =>
  value && options.some((option) => option.id === value) ? [value] : [];

export class QiMangaAdvancedSearchForm extends AdvancedSearchForm {
  private readonly genreOptions: Tag[];
  private genre: string[];
  private status: string[];
  private type: string[];

  constructor(query: SearchQuery<QiMangaSearchMetadata>, genreOptions: Tag[]) {
    super();
    this.genreOptions = genreOptions.map((option) => ({ ...option }));
    const metadata = query.metadata ?? {};
    this.genre = selected(metadata.genre, this.genreOptions);
    this.status = selected(metadata.status, STATUS_OPTIONS);
    this.type = selected(metadata.type, TYPE_OPTIONS);
  }

  override getSections() {
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
    this.genre = selected(value[0], this.genreOptions);
  }

  async handleStatusChange(value: string[]): Promise<void> {
    this.status = selected(value[0], STATUS_OPTIONS);
  }

  async handleTypeChange(value: string[]): Promise<void> {
    this.type = selected(value[0], TYPE_OPTIONS);
  }

  override getSearchQueryMetadata(): QiMangaSearchMetadata {
    return {
      ...(this.genre[0] && { genre: this.genre[0] }),
      ...(this.status[0] && { status: this.status[0] }),
      ...(this.type[0] && { type: this.type[0] }),
    };
  }
}
