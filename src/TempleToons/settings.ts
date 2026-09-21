import { Form, LabelRow, Section } from "@paperback/types";

export class TempleSettingsForm extends Form {
  override getSections() {
    return [
      Section("access", [
        LabelRow("anonymous", {
          title: "Anonymous access",
          subtitle:
            "Temple Scan serves its catalog, search, and free chapters without an account. Premium chapters stay locked to accounts.",
        }),
      ]),
    ];
  }
}
