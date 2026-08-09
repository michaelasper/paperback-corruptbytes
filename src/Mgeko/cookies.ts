import type { Cookie } from "@paperback/types";

import { SecureCookieInterceptor } from "../shared/cookies.js";
import { isHttpsUrlForHosts } from "../shared/url.js";

export const MGEKO_COOKIE_STATE_KEY = "mgeko.secure_cookies";
const GENERATION_HEADER = "x-paperback-mgeko-cookie-generation";
const COOKIE_HOSTS = new Set(["mgeko.cc", "www.mgeko.cc"]);

const cookieDomain = (cookie: Cookie): string =>
  cookie.domain.trim().replace(/^\.+/, "").toLowerCase();

export const isMgekoCloudflareCookieName = (name: string): boolean =>
  /^(?:cf|_cf|__cf)/i.test(name);

export const isMgekoCookie = (cookie: Cookie): boolean => {
  const domain = cookieDomain(cookie);
  return (
    (domain === "mgeko.cc" || domain === "www.mgeko.cc") && isMgekoCloudflareCookieName(cookie.name)
  );
};

export class MgekoCookieInterceptor extends SecureCookieInterceptor {
  constructor() {
    super({
      stateKey: MGEKO_COOKIE_STATE_KEY,
      generationHeader: GENERATION_HEADER,
      isTrustedRequestUrl: (value) => isHttpsUrlForHosts(value, COOKIE_HOSTS),
      isAcceptedCookie: isMgekoCookie,
      isSensitiveCookieName: isMgekoCloudflareCookieName,
    });
  }
}
