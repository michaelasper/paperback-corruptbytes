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
  replaceVortexCookies,
  signOut,
  type AccountStatus,
  type CookieStore,
} from "./auth.js";
import { DOMAIN } from "./network.js";

const SHOW_LOCKED_KEY = "vortex_scans.show_locked_chapters";
const LOGIN_URL = `${DOMAIN}/auth/signin`;

export const getShowLockedChapters = (): boolean => {
  const stored = Application.getState(SHOW_LOCKED_KEY);
  return typeof stored === "boolean" ? stored : true;
};

export class VortexSettingsForm extends Form {
  constructor(
    private readonly cookieStore: CookieStore,
    public account: AccountStatus,
  ) {
    super();
  }

  async handleShowLockedChange(value: boolean): Promise<void> {
    Application.setState(value, SHOW_LOCKED_KEY);
    this.reloadForm();
  }

  async handleLoginComplete(cookies: Cookie[]): Promise<void> {
    replaceVortexCookies(this.cookieStore, cookies);
    this.account = await fetchAccountStatus(this.cookieStore);
    this.reloadForm();
  }

  async handleLoginCancel(): Promise<void> {
    this.account = await fetchAccountStatus(this.cookieStore);
    this.reloadForm();
  }

  async handleLogout(): Promise<void> {
    await signOut(this.cookieStore);
    this.account = { authenticated: false };
    this.reloadForm();
  }

  override getSections() {
    const identity = this.account.displayName || this.account.email;
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
            "Vortex handles Google and Discord sign-in on its own page. " +
            "Paperback stores only the resulting Vortex session cookies; your password is never stored by this extension.",
        },
        [
          LabelRow("account_status", {
            title: "Account status",
            value: status,
          }),
          WebViewRow("login", {
            title: "Sign in to Vortex Scans",
            request: { url: LOGIN_URL, method: "GET" },
            onComplete: Application.Selector(this as VortexSettingsForm, "handleLoginComplete"),
            onCancel: Application.Selector(this as VortexSettingsForm, "handleLoginCancel"),
          }),
          ButtonRow("logout", {
            title: "Sign out and clear session",
            isHidden: !this.account.authenticated,
            onSelect: Application.Selector(this as VortexSettingsForm, "handleLogout"),
          }),
        ],
      ),
      Section(
        {
          id: "chapters",
          footer:
            "Purchased chapters become readable after you sign in. Other paid chapters are marked with 🔒 and must be unlocked on Vortex Scans.",
        },
        [
          ToggleRow("show_locked", {
            title: "Show locked paid chapters",
            subtitle: "Keep unavailable chapters visible with a lock marker.",
            value: getShowLockedChapters(),
            onValueChange: Application.Selector(
              this as VortexSettingsForm,
              "handleShowLockedChange",
            ),
          }),
        ],
      ),
    ];
  }
}
