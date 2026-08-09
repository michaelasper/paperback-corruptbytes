import { ButtonRow, Form, LabelRow, Section, WebViewRow, type Cookie } from "@paperback/types";

import type { MadaraCookieStore, MdxAuthContract } from "./auth.js";
import { isMadaraDexCookie } from "./cookies.js";
import { ROOT_URL } from "./network.js";

export class MadaraDexSettingsForm extends Form {
  constructor(
    private readonly auth: MdxAuthContract,
    private readonly cookieStore: MadaraCookieStore,
    private readonly onAuthenticationChanged: () => void = () => undefined,
  ) {
    super();
  }

  async handleRefresh(): Promise<void> {
    await this.auth.refresh(true);
    this.onAuthenticationChanged();
    this.reloadForm();
  }

  async handleVerificationComplete(cookies: Cookie[]): Promise<void> {
    this.cookieStore.acceptSensitiveCookies?.();
    for (const cookie of cookies) {
      if (isMadaraDexCookie(cookie)) this.cookieStore.setCookie(cookie);
    }
    await this.auth.refresh(true);
    this.onAuthenticationChanged();
    this.reloadForm();
  }

  async handleVerificationCancel(): Promise<void> {
    this.reloadForm();
  }

  override getSections() {
    return [
      Section(
        {
          id: "readerAccess",
          footer:
            "MadaraDex issues short-lived reader authorization automatically; no account or login is required. Open verification only if the site presents a browser challenge.",
        },
        [
          LabelRow("readerAccessStatus", {
            title: "Reader access",
            value: this.auth.isAuthenticated() ? "Ready" : "Will refresh automatically",
          }),
          ButtonRow("refreshReaderAccess", {
            title: "Refresh reader access",
            onSelect: Application.Selector(this as MadaraDexSettingsForm, "handleRefresh"),
          }),
          WebViewRow("verification", {
            title: "Open MadaraDex verification",
            request: { url: ROOT_URL, method: "GET" },
            onComplete: Application.Selector(
              this as MadaraDexSettingsForm,
              "handleVerificationComplete",
            ),
            onCancel: Application.Selector(
              this as MadaraDexSettingsForm,
              "handleVerificationCancel",
            ),
          }),
        ],
      ),
    ];
  }
}
