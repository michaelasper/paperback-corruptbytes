import type { Cookie } from "@paperback/types";

import { SecureCookieInterceptor } from "../shared/cookies.js";
import { isHttpsUrlForHosts } from "../shared/url.js";

export const ROKARI_COOKIE_STATE_KEY = "rokari.secure_cookies";
const GENERATION_HEADER = "x-paperback-rokari-cookie-generation";
const COOKIE_HOSTS = new Set(["rokaricomics.com", "www.rokaricomics.com"]);

const cookieDomain = (cookie: Cookie): string =>
  cookie.domain.trim().replace(/^\.+/, "").toLowerCase();

export const isRokariCloudflareCookieName = (name: string): boolean =>
  /^(?:cf|_cf|__cf)/i.test(name);

export const isRokariCookie = (cookie: Cookie): boolean => {
  const domain = cookieDomain(cookie);
  return (
    (domain === "rokaricomics.com" || domain === "www.rokaricomics.com") &&
    isRokariCloudflareCookieName(cookie.name)
  );
};

export class RokariCookieInterceptor extends SecureCookieInterceptor {
  constructor() {
    super({
      stateKey: ROKARI_COOKIE_STATE_KEY,
      generationHeader: GENERATION_HEADER,
      isTrustedRequestUrl: (value) => isHttpsUrlForHosts(value, COOKIE_HOSTS),
      isAcceptedCookie: isRokariCookie,
      isSensitiveCookieName: isRokariCloudflareCookieName,
    });
  }
}
