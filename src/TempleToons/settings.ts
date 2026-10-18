import { Form, LabelRow, Section, ToggleRow } from "@paperback/types";

const SHOW_LOCKED_KEY = "temple_scan.show_locked_chapters";

export const getShowLockedChapters = (): boolean => {
  const stored = Application.getState(SHOW_LOCKED_KEY);
  return typeof stored === "boolean" ? stored : true;
};

export class TempleSettingsForm extends Form {
  async handleShowLockedChange(value: boolean): Promise<void> {
    Application.setState(value, SHOW_LOCKED_KEY);
    this.reloadForm();
  }

  override getSections() {
    return [
      Section("access", [
        LabelRow("anonymous", {
          title: "Anonymous access",
          subtitle:
            "Temple Scan serves its catalog, search, and free chapters without an account. Premium chapters stay locked to accounts.",
        }),
      ]),
      Section("chapters", [
        ToggleRow("show_locked", {
          title: "Show locked premium chapters",
          subtitle:
            "Keep premium chapters visible. They still require a Temple Scan account to read.",
          value: getShowLockedChapters(),
          onValueChange: Application.Selector(this as TempleSettingsForm, "handleShowLockedChange"),
        }),
      ]),
    ];
  }
}
