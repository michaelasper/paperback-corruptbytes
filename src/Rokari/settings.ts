import { Form, LabelRow, Section } from "@paperback/types";

export class RokariSettingsForm extends Form {
  override getSections() {
    return [
      Section("access", [
        LabelRow("anonymous", {
          title: "Anonymous access",
          subtitle:
            "Rokari Comics serves its catalog, search, and chapters without an account. One series fetch powers details and chapters together.",
        }),
      ]),
    ];
  }
}
