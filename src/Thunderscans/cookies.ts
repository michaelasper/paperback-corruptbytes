import { SecureCookieInterceptor } from "../shared/cookies.js";
import { isHttpsUrlForHosts } from "../shared/url.js";
import { isThunderAuthCookieName, isThunderCookie, isThunderScopedCookieName } from "./auth.js";

export const THUNDER_COOKIE_STATE_KEY = "thunder_scans.secure_cookies";
const GENERATION_HEADER = "x-paperback-thunder-cookie-generation";
const COOKIE_HOSTS = new Set(["en-thunderscans.com"]);

export class ThunderCookieInterceptor extends SecureCookieInterceptor {
  constructor() {
    super({
      stateKey: THUNDER_COOKIE_STATE_KEY,
      generationHeader: GENERATION_HEADER,
      isTrustedRequestUrl: (value) => isHttpsUrlForHosts(value, COOKIE_HOSTS),
      isAcceptedCookie: isThunderCookie,
      isSensitiveCookieName: isThunderAuthCookieName,
      shouldStripCookieName: isThunderScopedCookieName,
    });
  }

  invalidateAuthCookies(): void {
    this.invalidateSensitiveCookies();
  }

  acceptAuthCookies(): void {
    this.acceptSensitiveCookies();
  }
}
