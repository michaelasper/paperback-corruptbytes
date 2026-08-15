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
  clearNovelDashAuthCookies,
  fetchNovelDashAccountStatus,
  replaceNovelDashCookies,
  type NovelDashAccountStatus,
  type NovelDashCookieStore,
} from "./noveldash-auth.js";
import type { NovelDashSite } from "./noveldash-models.js";

const showLockedKey = (site: NovelDashSite): string => `${site.key}.show_locked_chapters`;

export const getNovelDashShowLockedChapters = (site: NovelDashSite): boolean => {
  const stored = Application.getState(showLockedKey(site));
  return typeof stored === "boolean" ? stored : true;
};

export class NovelDashSettingsForm extends Form {
  constructor(
    private readonly site: NovelDashSite,
    private readonly cookieStore: NovelDashCookieStore,
    public account: NovelDashAccountStatus,
    private readonly onAuthenticationChanged: () => void = () => undefined,
  ) {
    super();
  }

  async handleShowLockedChange(value: boolean): Promise<void> {
    Application.setState(value, showLockedKey(this.site));
    this.reloadForm();
  }

  async handleLoginComplete(cookies: Cookie[]): Promise<void> {
    replaceNovelDashCookies(this.site, this.cookieStore, cookies);
    this.onAuthenticationChanged();
    this.account = await fetchNovelDashAccountStatus(this.site, this.cookieStore);
    this.reloadForm();
  }

  async handleLoginCancel(): Promise<void> {
    this.account = await fetchNovelDashAccountStatus(this.site, this.cookieStore);
    this.reloadForm();
  }

  async handleClearSession(): Promise<void> {
    clearNovelDashAuthCookies(this.cookieStore);
    this.onAuthenticationChanged();
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
            `Sign in on ${this.site.name}, then tap Done. Credentials stay in the site’s WebView; ` +
            "the extension securely stores only first-party session cookies.",
        },
        [
          LabelRow("account_status", { title: "Account status", value: status }),
          WebViewRow("login", {
            title: `Sign in to ${this.site.name}`,
            request: { url: `${this.site.domain}/login`, method: "GET" },
            onComplete: Application.Selector(this as NovelDashSettingsForm, "handleLoginComplete"),
            onCancel: Application.Selector(this as NovelDashSettingsForm, "handleLoginCancel"),
          }),
          ButtonRow("clear_session", {
            title: "Clear saved session",
            isHidden: !this.account.authenticated,
            onSelect: Application.Selector(this as NovelDashSettingsForm, "handleClearSession"),
          }),
        ],
      ),
      Section(
        {
          id: "chapters",
          footer: `Paid chapters must be unlocked on ${this.site.name}. This extension never purchases or bypasses locked content.`,
        },
        [
          ToggleRow("show_locked", {
            title: "Show locked paid chapters",
            subtitle: "Keep unavailable chapters visible with their coin price.",
            value: getNovelDashShowLockedChapters(this.site),
            onValueChange: Application.Selector(
              this as NovelDashSettingsForm,
              "handleShowLockedChange",
            ),
          }),
        ],
      ),
    ];
  }
}
