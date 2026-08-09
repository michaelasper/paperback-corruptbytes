import { SecureCookieInterceptor } from "../shared/cookies.js";
import { isHttpsUrlForHosts } from "../shared/url.js";
import { isVortexAuthCookieName, isVortexCookie } from "./auth.js";

export const VORTEX_COOKIE_STATE_KEY = "vortex_scans.secure_cookies";
const AUTH_GENERATION_HEADER = "x-paperback-vortex-cookie-generation";
const COOKIE_HOSTS = new Set([
  "vortexscans.org",
  "www.vortexscans.org",
  "api.vortexscans.org",
  "dashboard.vortexscans.org",
]);

/** Secure Vortex configuration for the repository's shared cookie engine. */
export class VortexCookieInterceptor extends SecureCookieInterceptor {
  constructor() {
    super({
      stateKey: VORTEX_COOKIE_STATE_KEY,
      generationHeader: AUTH_GENERATION_HEADER,
      isTrustedRequestUrl: (value) => isHttpsUrlForHosts(value, COOKIE_HOSTS),
      isAcceptedCookie: isVortexCookie,
      isSensitiveCookieName: isVortexAuthCookieName,
    });
  }

  invalidateAuthCookies(): void {
    this.invalidateSensitiveCookies();
  }

  acceptAuthCookies(): void {
    this.acceptSensitiveCookies();
  }
}
