import { URL as PaperbackURL } from "@paperback/types";

import { SecureCookieInterceptor } from "../shared/cookies.js";
import { isHttpsUrlForHosts } from "../shared/url.js";
import { isQiMangaAuthCookieName, isQiMangaCookie, type QiMangaCookieStore } from "./auth.js";

export const QIMANGA_COOKIE_STATE_KEY = "qi_manga.secure_cookies";
const GENERATION_HEADER = "x-paperback-qimanga-cookie-generation";
const COOKIE_HOSTS = new Set(["qimanga.com", "api.qimanga.com"]);

const isTrustedCookieRequestUrl = (value: string): boolean => {
  if (!isHttpsUrlForHosts(value, COOKIE_HOSTS)) return false;
  try {
    const url = new PaperbackURL(value);
    return !(url.hostname.toLowerCase() === "qimanga.com" && url.path === "/qiscans.ico");
  } catch {
    return false;
  }
};

/**
 * Keep caller cookies on Qi Manga's account-bearing origins. Reader CDNs and
 * the fixed public fallback icon stay cookie-neutral.
 */
export class QiMangaCookieInterceptor
  extends SecureCookieInterceptor
  implements QiMangaCookieStore
{
  constructor() {
    super({
      stateKey: QIMANGA_COOKIE_STATE_KEY,
      generationHeader: GENERATION_HEADER,
      isTrustedRequestUrl: isTrustedCookieRequestUrl,
      isAcceptedCookie: isQiMangaCookie,
      isSensitiveCookieName: isQiMangaAuthCookieName,
      shouldStripCookieName: () => true,
    });
  }

  invalidateAuthCookies(): void {
    this.invalidateSensitiveCookies();
  }

  acceptAuthCookies(): void {
    this.acceptSensitiveCookies();
  }
}
