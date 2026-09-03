import {
  AdvancedSearchForm,
  Section,
  SelectRow,
  type SearchQuery,
  type Tag,
} from "@paperback/types";

import type { RinkoSearchMetadata } from "./models.js";
import { MAX_GENRE_FILTERS, normalizeRinkoSearchQuery } from "./network.js";

const selectedGenres = (value: unknown, options: readonly Tag[]): string[] => {
  const selected = normalizeRinkoSearchQuery({
    title: "",
    ...(value !== undefined && { metadata: { genres: value } }),
  }).metadata?.genres;
  if (!selected) return [];
  const available = new Set(options.map((option) => option.id));
  if (selected.some((candidate) => !available.has(candidate))) {
    throw new Error("Rinko Comics genre filters are invalid.");
  }
  return selected;
};

export class RinkoComicsAdvancedSearchForm extends AdvancedSearchForm {
  private readonly genreOptions: Tag[];
  private genres: string[];

  constructor(query: SearchQuery<RinkoSearchMetadata>, genreOptions: readonly Tag[]) {
    super();
    this.genreOptions = genreOptions.map((option) => ({ ...option }));
    this.genres = selectedGenres(query.metadata?.genres, this.genreOptions);
  }

  override getSections() {
    return [
      Section(
        {
          id: "genres",
          footer:
            "Genre filters and sorting mirror Rinko Comics' public catalog. Only publicly readable chapters are returned.",
        },
        [
          SelectRow("genres", {
            title: "Genres",
            layout: "list",
            value: [...this.genres],
            items: this.genreOptions.map((option) => ({ ...option })),
            minItemCount: 0,
            maxItemCount: Math.min(this.genreOptions.length, MAX_GENRE_FILTERS),
            onValueChange: Application.Selector(
              this as RinkoComicsAdvancedSearchForm,
              "handleGenresChange",
            ),
          }),
        ],
      ),
    ];
  }

  async handleGenresChange(value: string[]): Promise<void> {
    this.genres = selectedGenres(value, this.genreOptions);
  }

  override getSearchQueryMetadata(): RinkoSearchMetadata {
    return this.genres.length > 0 ? { genres: [...this.genres] } : {};
  }
}
