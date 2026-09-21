import type { Cookie } from "@paperback/types";

import { SecureCookieInterceptor } from "../shared/cookies.js";
import { isHttpsUrlForHosts } from "../shared/url.js";

export const TEMPLE_COOKIE_STATE_KEY = "temple.secure_cookies";
const GENERATION_HEADER = "x-paperback-temple-cookie-generation";
const COOKIE_HOSTS = new Set(["templetoons.com", "www.templetoons.com"]);

const cookieDomain = (cookie: Cookie): string =>
  cookie.domain.trim().replace(/^\.+/, "").toLowerCase();

export const isTempleCloudflareCookieName = (name: string): boolean =>
  /^(?:cf|_cf|__cf)/i.test(name);

export const isTempleCookie = (cookie: Cookie): boolean => {
  const domain = cookieDomain(cookie);
  return (
    (domain === "templetoons.com" || domain === "www.templetoons.com") &&
    isTempleCloudflareCookieName(cookie.name)
  );
};

export class TempleCookieInterceptor extends SecureCookieInterceptor {
  constructor() {
    super({
      stateKey: TEMPLE_COOKIE_STATE_KEY,
      generationHeader: GENERATION_HEADER,
      isTrustedRequestUrl: (value) => isHttpsUrlForHosts(value, COOKIE_HOSTS),
      isAcceptedCookie: isTempleCookie,
      isSensitiveCookieName: isTempleCloudflareCookieName,
    });
  }
}
