import {
  ButtonRow,
  Form,
  LabelRow,
  Section,
  ToggleRow,
  WebViewRow,
  type Cookie,
} from "@paperback/types";

import {
  fetchAccountStatus,
  invalidateThunderAuth,
  replaceThunderCookies,
  type AccountStatus,
  type ThunderCookieStore,
} from "./auth.js";
import { LOGIN_URL } from "./network.js";

const SHOW_LOCKED_KEY = "thunder_scans.show_locked_chapters";

export const getShowLockedChapters = (): boolean => {
  const stored = Application.getState(SHOW_LOCKED_KEY);
  return typeof stored === "boolean" ? stored : true;
};

export class ThunderSettingsForm extends Form {
  constructor(
    private readonly cookieStore: ThunderCookieStore,
    public account: AccountStatus,
    private readonly onAuthenticationChanged: () => void = () => undefined,
  ) {
    super();
  }

  async handleShowLockedChange(value: boolean): Promise<void> {
    Application.setState(value, SHOW_LOCKED_KEY);
    this.reloadForm();
  }

  async handleLoginComplete(cookies: Cookie[]): Promise<void> {
    replaceThunderCookies(this.cookieStore, cookies);
    this.onAuthenticationChanged();
    this.account = await fetchAccountStatus(this.cookieStore);
    this.reloadForm();
  }

  async handleLoginCancel(): Promise<void> {
    this.account = await fetchAccountStatus(this.cookieStore);
    this.reloadForm();
  }

  async handleLogout(): Promise<void> {
    invalidateThunderAuth(this.cookieStore);
    this.onAuthenticationChanged();
    this.account = { authenticated: false };
    this.reloadForm();
  }

  override getSections() {
    const identity = this.account.displayName;
    const status = this.account.authenticated
      ? identity
        ? `Logged in as ${identity}`
        : "Logged in"
      : "Not logged in";

    return [
      Section(
        {
          id: "account",
          footer:
            "Sign in on Thunder Scans, then tap Done after the profile page loads. Credentials stay in the site’s WebView; the extension stores only first-party session cookies.",
        },
        [
          LabelRow("account_status", { title: "Account status", value: status }),
          WebViewRow("login", {
            title: "Sign in to Thunder Scans",
            request: { url: LOGIN_URL, method: "GET" },
            onComplete: Application.Selector(this as ThunderSettingsForm, "handleLoginComplete"),
            onCancel: Application.Selector(this as ThunderSettingsForm, "handleLoginCancel"),
          }),
          ButtonRow("logout", {
            title: "Sign out and clear session",
            isHidden: !this.account.authenticated,
            onSelect: Application.Selector(this as ThunderSettingsForm, "handleLogout"),
          }),
        ],
      ),
      Section(
        {
          id: "chapters",
          footer:
            "Purchased chapters become readable after sign-in. Other paid chapters are shown with a lock and coin price; this extension never purchases or unlocks content.",
        },
        [
          ToggleRow("show_locked", {
            title: "Show locked paid chapters",
            subtitle: "Keep unavailable chapters visible with their coin price.",
            value: getShowLockedChapters(),
            onValueChange: Application.Selector(
              this as ThunderSettingsForm,
              "handleShowLockedChange",
            ),
          }),
        ],
      ),
    ];
  }
}
