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
const authenticationOperations = new WeakMap<QiMangaCookieStore, number>();

export const getShowLockedChapters = (): boolean => {
  try {
    const stored = Application.getState(SHOW_LOCKED_KEY);
    return typeof stored === "boolean" ? stored : true;
  } catch {
    return true;
  }
};

export class QiMangaSettingsForm extends Form {
  private authenticationOperation = 0;

  constructor(
    private readonly cookieStore: QiMangaCookieStore,
    public account: QiMangaAccountStatus,
    private readonly onAuthenticationChanged: () => void = () => undefined,
  ) {
    super();
  }

  private beginAuthenticationOperation(): number {
    const operation = (authenticationOperations.get(this.cookieStore) ?? 0) + 1;
    authenticationOperations.set(this.cookieStore, operation);
    this.authenticationOperation = operation;
    return operation;
  }

  private isAuthenticationOperationCurrent(operation: number): boolean {
    return (
      operation === this.authenticationOperation &&
      operation === authenticationOperations.get(this.cookieStore)
    );
  }

  async handleShowLockedChange(value: boolean): Promise<void> {
    if (typeof value !== "boolean") return;
    Application.setState(value, SHOW_LOCKED_KEY);
    this.reloadForm();
  }

  async handleLoginComplete(cookies: Cookie[]): Promise<void> {
    const operation = this.beginAuthenticationOperation();
    replaceQiMangaCookies(this.cookieStore, cookies);
    const account = await fetchQiMangaAccountStatus(this.cookieStore, () =>
      this.isAuthenticationOperationCurrent(operation),
    );
    if (!this.isAuthenticationOperationCurrent(operation)) return;

    this.account = account;
    // Captured WebView credentials are untrusted until this exact imported session
    // verifies. Never retain them after an ambiguous, malformed, or failed check.
    if (!account.authenticated) invalidateQiMangaAuth(this.cookieStore);
    this.onAuthenticationChanged();
    this.reloadForm();
  }

  async handleLoginCancel(): Promise<void> {
    const operation = this.beginAuthenticationOperation();
    const account = await fetchQiMangaAccountStatus(this.cookieStore, () =>
      this.isAuthenticationOperationCurrent(operation),
    );
    if (!this.isAuthenticationOperationCurrent(operation)) return;

    this.account = account;
    if (!account.authenticated) invalidateQiMangaAuth(this.cookieStore);
    this.onAuthenticationChanged();
    this.reloadForm();
  }

  async handleLogout(): Promise<void> {
    const operation = this.beginAuthenticationOperation();
    await signOutQiManga(this.cookieStore);
    if (!this.isAuthenticationOperationCurrent(operation)) return;

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
