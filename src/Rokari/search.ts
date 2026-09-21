import {
  AdvancedSearchForm,
  Section,
  TriStateSelectRow,
  type SearchQuery,
  type Tag,
} from "@paperback/types";

import type { RokariSearchMetadata } from "./models.js";

export class RokariAdvancedSearchForm extends AdvancedSearchForm {
  private genres: Record<string, "included" | "excluded">;

  constructor(
    query: SearchQuery<RokariSearchMetadata>,
    private readonly genreOptions: Tag[],
  ) {
    super();
    const metadata = query.metadata ?? {};
    this.genres = Array.isArray(metadata.genres)
      ? Object.fromEntries(metadata.genres.map((genre) => [genre, "included" as const]))
      : { ...(metadata as { genres?: Record<string, "included" | "excluded"> }).genres };
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
            this as RokariAdvancedSearchForm,
            "handleGenresChange",
          ),
        }),
      ]),
    ];
  }

  async handleGenresChange(value: Record<string, "included" | "excluded">): Promise<void> {
    this.genres = { ...value };
  }

  override getSearchQueryMetadata(): RokariSearchMetadata {
    const included = Object.entries(this.genres)
      .filter(([, state]) => state === "included")
      .map(([id]) => id);
    return {
      ...(included.length > 0 && { genres: included }),
    };
  }
}
