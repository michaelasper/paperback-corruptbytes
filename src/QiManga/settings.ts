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
  fetchQiMangaAccountStatus,
  hasQiMangaAuthCookies,
  invalidateQiMangaAuth,
  replaceQiMangaCookies,
  signOutQiManga,
  type QiMangaAccountStatus,
  type QiMangaCookieStore,
} from "./auth.js";
import { DOMAIN } from "./network.js";

const SHOW_LOCKED_KEY = "qi_manga.show_locked_chapters";
const LOGIN_URL = `${DOMAIN}/login`;

export const getShowLockedChapters = (): boolean => {
  const stored = Application.getState(SHOW_LOCKED_KEY);
  return typeof stored === "boolean" ? stored : true;
};

export class QiMangaSettingsForm extends Form {
  constructor(
    private readonly cookieStore: QiMangaCookieStore,
    public account: QiMangaAccountStatus,
    private readonly onAuthenticationChanged: () => void = () => undefined,
  ) {
    super();
  }

  async handleShowLockedChange(value: boolean): Promise<void> {
    Application.setState(value, SHOW_LOCKED_KEY);
    this.reloadForm();
  }

  async handleLoginComplete(cookies: Cookie[]): Promise<void> {
    replaceQiMangaCookies(this.cookieStore, cookies);
    this.account = await fetchQiMangaAccountStatus(this.cookieStore);
    if (!this.account.authenticated) invalidateQiMangaAuth(this.cookieStore);
    this.onAuthenticationChanged();
    this.reloadForm();
  }

  async handleLoginCancel(): Promise<void> {
    this.account = await fetchQiMangaAccountStatus(this.cookieStore);
    this.onAuthenticationChanged();
    this.reloadForm();
  }

  async handleLogout(): Promise<void> {
    await signOutQiManga(this.cookieStore);
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
    const canClearSession = this.account.authenticated || hasQiMangaAuthCookies(this.cookieStore);

    return [
      Section(
        {
          id: "account",
          footer:
            "Sign in on Qi Manga, then tap Done. Credentials stay inside Qi Manga's WebView; " +
            "the extension stores only first-party session cookies so chapters you already purchased can be read.",
        },
        [
          LabelRow("account_status", { title: "Account status", value: status }),
          WebViewRow("login", {
            title: "Sign in to Qi Manga",
            request: { url: LOGIN_URL, method: "GET" },
            onComplete: Application.Selector(this as QiMangaSettingsForm, "handleLoginComplete"),
            onCancel: Application.Selector(this as QiMangaSettingsForm, "handleLoginCancel"),
          }),
          ButtonRow("logout", {
            title: "Sign out and clear session",
            isHidden: !canClearSession,
            onSelect: Application.Selector(this as QiMangaSettingsForm, "handleLogout"),
          }),
        ],
      ),
      Section(
        {
          id: "chapters",
          footer:
            "Purchased chapters become readable after sign-in. Other paid chapters remain marked with a lock; this extension never purchases or unlocks content.",
        },
        [
          ToggleRow("show_locked", {
            title: "Show locked paid chapters",
            subtitle: "Keep unavailable chapters visible with their current coin price.",
            value: getShowLockedChapters(),
            onValueChange: Application.Selector(
              this as QiMangaSettingsForm,
              "handleShowLockedChange",
            ),
          }),
        ],
      ),
    ];
  }
}
