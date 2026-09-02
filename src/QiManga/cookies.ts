import type { Request } from "@paperback/types";

import { SecureCookieInterceptor } from "../shared/cookies.js";
import { headerValue } from "../shared/http.js";
import { isHttpsUrlForHosts } from "../shared/url.js";
import {
  isQiMangaAuthCookieName,
  isQiMangaCookie,
  QIMANGA_COOKIE_GENERATION_HEADER,
  qiMangaAuthCookiesForUrl,
  type QiMangaCookieStore,
} from "./auth.js";
import { isApiRequestUrl, isPublicFallbackAssetUrl } from "./network.js";

export const QIMANGA_COOKIE_STATE_KEY = "qi_manga.secure_cookies";
const COOKIE_HOSTS = new Set(["qimanga.com", "api.qimanga.com"]);

const isTrustedCookieRequestUrl = (value: string): boolean =>
  typeof value === "string" &&
  value.length <= 2_048 &&
  isHttpsUrlForHosts(value, COOKIE_HOSTS) &&
  !isPublicFallbackAssetUrl(value);

/**
 * Keep caller cookies on Qi Manga's account-bearing origins. Reader CDNs and
 * the fixed public fallback icon stay cookie-neutral.
 */
export class QiMangaCookieInterceptor
  extends SecureCookieInterceptor
  implements QiMangaCookieStore
{
  private authenticationIdentityGeneration = 0;

  constructor() {
    super({
      stateKey: QIMANGA_COOKIE_STATE_KEY,
      generationHeader: QIMANGA_COOKIE_GENERATION_HEADER,
      isTrustedRequestUrl: isTrustedCookieRequestUrl,
      isAcceptedCookie: isQiMangaCookie,
      isSensitiveCookieName: isQiMangaAuthCookieName,
      shouldStripCookieName: () => true,
      maxCookieCount: 64,
      maxCookieBytes: 128 * 1_024,
    });
  }

  markAuthenticationChanged(): void {
    this.authenticationIdentityGeneration += 1;
  }

  invalidateAuthCookies(): void {
    this.markAuthenticationChanged();
    this.invalidateSensitiveCookies();
  }

  acceptAuthCookies(): void {
    this.acceptSensitiveCookies();
  }

  override async interceptRequest(request: Request): Promise<Request> {
    const apiRequest = isApiRequestUrl(request.url);
    const marker = headerValue(request.headers, QIMANGA_COOKIE_GENERATION_HEADER);
    const requestGeneration = Number(marker);
    const hasValidMarker =
      marker !== undefined &&
      Number.isSafeInteger(requestGeneration) &&
      requestGeneration >= 0 &&
      marker === String(requestGeneration);
    const canUseCurrentAuthentication =
      marker === undefined ||
      (hasValidMarker && requestGeneration === this.sensitiveCookieGeneration);
    // Capture before the first asynchronous boundary. A logout or account switch that
    // follows cannot replace this request's credentials with a newer session.
    const selectedAuthCookies =
      apiRequest && canUseCurrentAuthentication ? qiMangaAuthCookiesForUrl(this, request.url) : {};
    const intercepted = await super.interceptRequest(request);
    if (!apiRequest) return intercepted;

    // Paperback's stock jar applies stored cookies after caller cookies and keys the
    // outgoing map by name. Re-select scoped auth values so insertion order cannot
    // let a broad duplicate override the longest matching API domain/path cookie.
    const cookies = { ...intercepted.cookies };
    for (const name of Object.keys(cookies)) {
      if (isQiMangaAuthCookieName(name)) delete cookies[name];
    }
    Object.assign(cookies, selectedAuthCookies);

    // SecureCookieInterceptor normally stamps the generation at interception time.
    // Preserve a valid caller snapshot so this old request's response is also rejected
    // after logout or account replacement.
    const effectiveMarker = hasValidMarker
      ? marker
      : marker === undefined
        ? headerValue(intercepted.headers, QIMANGA_COOKIE_GENERATION_HEADER)
        : "-1";
    const headers = Object.fromEntries(
      Object.entries(intercepted.headers ?? {}).filter(
        ([name]) => name.toLowerCase() !== QIMANGA_COOKIE_GENERATION_HEADER,
      ),
    );
    if (effectiveMarker !== undefined) {
      headers[QIMANGA_COOKIE_GENERATION_HEADER] = effectiveMarker;
    }
    const result = { ...intercepted, headers };
    const hasCookies = Object.keys(cookies).length > 0;
    if (hasCookies) result.cookies = cookies;
    else delete result.cookies;

    // Paperback currently gives each registered request interceptor the same
    // original object and uses only the final interceptor's return value. Mirror
    // the scoped credentials and captured marker onto that shared object so the
    // later header interceptor cannot substitute a newer account.
    request.headers = headers;
    if (hasCookies) request.cookies = cookies;
    else delete request.cookies;
    return result;
  }

  get authIdentityGeneration(): number {
    return this.authenticationIdentityGeneration;
  }
}
