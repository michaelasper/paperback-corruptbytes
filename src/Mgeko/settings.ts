import { Form, Section, ToggleRow } from "@paperback/types";

export const SAFE_MODE_KEY = "safe_mode";

export const getSafeMode = (): boolean => {
  const stored = Application.getState(SAFE_MODE_KEY);
  if (typeof stored === "boolean") return stored;
  if (typeof stored === "string") return stored.toLowerCase() !== "false";
  return true;
};

export class MgekoSettingsForm extends Form {
  async handleSafeModeChange(value: boolean): Promise<void> {
    Application.setState(value, SAFE_MODE_KEY);
    this.reloadForm();
  }

  override getSections() {
    return [
      Section(
        {
          id: "content",
          footer:
            "Safe mode is applied by Mgeko’s catalog API. Direct links and previously saved titles remain accessible.",
        },
        [
          ToggleRow("safeMode", {
            title: "Safe mode",
            subtitle: "Hide adult titles from discover and search. Enabled by default.",
            value: getSafeMode(),
            onValueChange: Application.Selector(this as MgekoSettingsForm, "handleSafeModeChange"),
          }),
        ],
      ),
    ];
  }
}
