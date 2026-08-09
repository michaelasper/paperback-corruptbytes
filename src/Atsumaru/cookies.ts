import type { Cookie } from "@paperback/types";

import { SecureCookieInterceptor } from "../shared/cookies.js";
import { isHttpsUrlForHosts } from "../shared/url.js";

export const ATSUMARU_COOKIE_STATE_KEY = "atsumaru.secure_cookies";
export const ATSUMARU_COOKIE_GENERATION_HEADER = "x-paperback-atsumaru-cookie-generation";

const FIRST_PARTY_HOSTS = new Set(["atsu.moe", "www.atsu.moe"]);

const cookieDomain = (cookie: Cookie): string =>
  cookie.domain.trim().replace(/^\.+/, "").toLowerCase();

export const isAtsumaruCloudflareCookieName = (name: string): boolean =>
  /^(?:cf|_cf|__cf)/i.test(name);

/** Only first-party Atsumaru domains may contribute persisted challenge cookies. */
export const isAtsumaruCookie = (cookie: Cookie): boolean =>
  FIRST_PARTY_HOSTS.has(cookieDomain(cookie)) && isAtsumaruCloudflareCookieName(cookie.name);

export class AtsumaruCookieInterceptor extends SecureCookieInterceptor {
  constructor() {
    super({
      stateKey: ATSUMARU_COOKIE_STATE_KEY,
      generationHeader: ATSUMARU_COOKIE_GENERATION_HEADER,
      isTrustedRequestUrl: (value) => isHttpsUrlForHosts(value, FIRST_PARTY_HOSTS),
      isAcceptedCookie: isAtsumaruCookie,
      isSensitiveCookieName: isAtsumaruCloudflareCookieName,
    });
  }
}

export const ATSUMARU_COOKIE_GENERATION = ATSUMARU_COOKIE_GENERATION_HEADER;
