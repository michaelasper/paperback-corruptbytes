import {
  AdvancedSearchForm,
  InputRow,
  Section,
  SelectRow,
  type SearchQuery,
  type Tag,
} from "@paperback/types";

import type {
  MadaraAdultFilter,
  MadaraFilterOptions,
  MadaraGenreCondition,
  MadaraSearchMetadata,
} from "./models.js";

export const GENRE_CONDITIONS: Tag[] = [
  { id: "or", title: "Match any selected genre" },
  { id: "and", title: "Match every selected genre" },
];

export const ADULT_OPTIONS: Tag[] = [
  { id: "all", title: "All content" },
  { id: "none", title: "Exclude adult content" },
  { id: "only", title: "Adult content only" },
];

const clean = (value: string): string => value.trim().replace(/\s+/g, " ");

const unique = (values: string[]): string[] => [...new Set(values.map(clean).filter(Boolean))];

export class MadaraDexAdvancedSearchForm extends AdvancedSearchForm {
  private genres: string[];
  private genreCondition: MadaraGenreCondition;
  private author: string;
  private artist: string;
  private release: string;
  private adult: MadaraAdultFilter;
  private status: string[];

  constructor(
    query: SearchQuery<MadaraSearchMetadata>,
    private readonly options: MadaraFilterOptions,
  ) {
    super();
    const metadata = query.metadata ?? {};
    this.genres = [...(metadata.genres ?? [])];
    this.genreCondition = metadata.genreCondition ?? "or";
    this.author = metadata.author ?? "";
    this.artist = metadata.artist ?? "";
    this.release = metadata.release ?? "";
    this.adult = metadata.adult ?? "all";
    this.status = [...(metadata.status ?? [])];
  }

  override getSections() {
    return [
      Section("genres", [
        SelectRow("genres", {
          title: "Genres",
          layout: "flow",
          value: this.genres,
          items: this.options.genres,
          minItemCount: 0,
          maxItemCount: this.options.genres.length,
          onValueChange: Application.Selector(
            this as MadaraDexAdvancedSearchForm,
            "handleGenresChange",
          ),
        }),
      ]),
      Section("genreCondition", [
        SelectRow("genreCondition", {
          title: "Genre matching",
          layout: "list",
          value: [this.genreCondition],
          items: GENRE_CONDITIONS,
          minItemCount: 1,
          maxItemCount: 1,
          onValueChange: Application.Selector(
            this as MadaraDexAdvancedSearchForm,
            "handleGenreConditionChange",
          ),
        }),
      ]),
      Section("credits", [
        InputRow("author", {
          title: "Author",
          value: this.author,
          onValueChange: Application.Selector(
            this as MadaraDexAdvancedSearchForm,
            "handleAuthorChange",
          ),
        }),
        InputRow("artist", {
          title: "Artist",
          value: this.artist,
          onValueChange: Application.Selector(
            this as MadaraDexAdvancedSearchForm,
            "handleArtistChange",
          ),
        }),
        InputRow("release", {
          title: "Release year",
          value: this.release,
          onValueChange: Application.Selector(
            this as MadaraDexAdvancedSearchForm,
            "handleReleaseChange",
          ),
        }),
      ]),
      Section("availability", [
        SelectRow("adult", {
          title: "Adult content",
          layout: "list",
          value: [this.adult],
          items: ADULT_OPTIONS,
          minItemCount: 1,
          maxItemCount: 1,
          onValueChange: Application.Selector(
            this as MadaraDexAdvancedSearchForm,
            "handleAdultChange",
          ),
        }),
        SelectRow("status", {
          title: "Status",
          layout: "flow",
          value: this.status,
          items: this.options.statuses,
          minItemCount: 0,
          maxItemCount: this.options.statuses.length,
          onValueChange: Application.Selector(
            this as MadaraDexAdvancedSearchForm,
            "handleStatusChange",
          ),
        }),
      ]),
    ];
  }

  async handleGenresChange(value: string[]): Promise<void> {
    this.genres = [...value];
  }

  async handleGenreConditionChange(value: string[]): Promise<void> {
    this.genreCondition = value[0] === "and" ? "and" : "or";
  }

  async handleAuthorChange(value: string): Promise<void> {
    this.author = value;
  }

  async handleArtistChange(value: string): Promise<void> {
    this.artist = value;
  }

  async handleReleaseChange(value: string): Promise<void> {
    this.release = value;
  }

  async handleAdultChange(value: string[]): Promise<void> {
    this.adult = value[0] === "none" || value[0] === "only" ? value[0] : "all";
  }

  async handleStatusChange(value: string[]): Promise<void> {
    this.status = [...value];
  }

  override getSearchQueryMetadata(): MadaraSearchMetadata {
    const genres = unique(this.genres);
    const status = unique(this.status);
    const author = clean(this.author);
    const artist = clean(this.artist);
    const release = this.release.match(/(?:19|20)\d{2}/)?.[0];
    return {
      ...(genres.length > 0 && { genres }),
      ...(genres.length > 0 && this.genreCondition === "and" && { genreCondition: "and" }),
      ...(author && { author }),
      ...(artist && { artist }),
      ...(release && { release }),
      ...(this.adult !== "all" && { adult: this.adult }),
      ...(status.length > 0 && { status }),
    };
  }
}
