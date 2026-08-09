import type { Cookie } from "@paperback/types";

import { SecureCookieInterceptor } from "../shared/cookies.js";
import { isHttpsUrlForHosts } from "../shared/url.js";

export const MADARADEX_COOKIE_STATE_KEY = "madaradex.secure_cookies";
const GENERATION_HEADER = "x-paperback-madaradex-cookie-generation";
const TRUSTED_HOSTS = new Set(["madaradex.org", "www.madaradex.org", "cdn.madaradex.org"]);

const cookieDomain = (cookie: Cookie): string =>
  cookie.domain.trim().replace(/^\.+/, "").toLowerCase();

export const isMadaraCloudflareCookieName = (name: string): boolean =>
  /^(?:cf|_cf|__cf)/i.test(name);

export const isMadaraAuthCookieName = (name: string): boolean =>
  /^(?:mdx_fp|mdx_auth)$/i.test(name);

export const isMadaraRotatingAuthCookieName = (name: string): boolean => /^mdx_auth$/i.test(name);

export const isMadaraSensitiveCookieName = (name: string): boolean =>
  isMadaraAuthCookieName(name) || isMadaraCloudflareCookieName(name);

export const isMadaraDexCookie = (cookie: Cookie): boolean =>
  cookieDomain(cookie) === "madaradex.org" && isMadaraSensitiveCookieName(cookie.name);

export class MadaraDexCookieInterceptor extends SecureCookieInterceptor {
  constructor() {
    super({
      stateKey: MADARADEX_COOKIE_STATE_KEY,
      generationHeader: GENERATION_HEADER,
      isTrustedRequestUrl: (value) => isHttpsUrlForHosts(value, TRUSTED_HOSTS),
      isAcceptedCookie: isMadaraDexCookie,
      isSensitiveCookieName: isMadaraRotatingAuthCookieName,
      shouldStripCookieName: isMadaraSensitiveCookieName,
    });
  }
}
