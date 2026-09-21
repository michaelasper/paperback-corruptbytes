import {
  AdvancedSearchForm,
  Section,
  SelectRow,
  type SearchQuery,
  type Tag,
} from "@paperback/types";

import type { TempleSearchMetadata } from "./models.js";

export const STATUS_OPTIONS: Tag[] = [
  { id: "Ongoing", title: "Ongoing" },
  { id: "Hiatus", title: "Hiatus" },
  { id: "Completed", title: "Completed" },
  { id: "Canceled", title: "Canceled" },
  { id: "Dropped", title: "Dropped" },
];

export class TempleAdvancedSearchForm extends AdvancedSearchForm {
  private status: string[];

  constructor(query: SearchQuery<TempleSearchMetadata>) {
    super();
    this.status = [...(query.metadata?.status ?? [])];
  }

  override getSections() {
    return [
      Section("series", [
        SelectRow("status", {
          title: "Status",
          layout: "flow",
          value: this.status,
          items: STATUS_OPTIONS,
          minItemCount: 0,
          maxItemCount: 1,
          onValueChange: Application.Selector(
            this as TempleAdvancedSearchForm,
            "handleStatusChange",
          ),
        }),
      ]),
    ];
  }

  async handleStatusChange(value: string[]): Promise<void> {
    this.status = [...value];
  }

  override getSearchQueryMetadata(): TempleSearchMetadata {
    return {
      ...(this.status.length > 0 && { status: [...this.status] }),
    };
  }
}
