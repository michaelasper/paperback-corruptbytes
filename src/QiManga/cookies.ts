import { URL as PaperbackURL, type Cookie, type Request, type Response } from "@paperback/types";

import { utf8ByteLength } from "../shared/async-cache.js";
import { SecureCookieInterceptor } from "../shared/cookies.js";
import { isHttpsUrlForHosts } from "../shared/url.js";
import {
  isQiMangaAuthCookieName,
  isQiMangaCookie,
  MAX_QIMANGA_COOKIE_CANDIDATES,
  type QiMangaCookieStore,
} from "./auth.js";

export const QIMANGA_COOKIE_STATE_KEY = "qi_manga.secure_cookies";
export const MAX_QIMANGA_COOKIE_COUNT = 64;
export const MAX_QIMANGA_COOKIE_BYTES = 128 * 1_024;
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

const storedDate = (value: unknown): Date | undefined => {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value;
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
};

const deserializeCookie = (value: unknown): Cookie | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Partial<Cookie> & { created?: unknown; expires?: unknown };
  if (
    typeof raw.name !== "string" ||
    typeof raw.value !== "string" ||
    typeof raw.domain !== "string"
  ) {
    return undefined;
  }
  const expires = storedDate(raw.expires);
  if (raw.expires != null && !expires) return undefined;
  const created = storedDate(raw.created);
  const cookie: Cookie = {
    name: raw.name,
    value: raw.value,
    domain: raw.domain,
    ...(typeof raw.path === "string" && { path: raw.path }),
    ...(created && { created }),
    ...(expires && { expires }),
  };
  return isQiMangaCookie(cookie) ? cookie : undefined;
};

const canonicalCookie = (cookie: Cookie): Cookie => ({
  name: cookie.name,
  value: cookie.value,
  domain: cookie.domain,
  ...(cookie.path !== undefined && { path: cookie.path }),
  ...(cookie.created && { created: new Date(cookie.created.getTime()) }),
  ...(cookie.expires && { expires: new Date(cookie.expires.getTime()) }),
});

const cookieIdentifier = (cookie: Cookie): string => {
  const domain = cookie.domain.replace(/^(www)?\.?/i, "").toLowerCase();
  const path = cookie.path?.startsWith("/") ? cookie.path : `/${cookie.path ?? ""}`;
  return `${cookie.name}-${domain}-${path}`;
};

const cookieWeight = (cookie: Cookie): number =>
  utf8ByteLength(
    JSON.stringify({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path,
      created: cookie.created?.toISOString(),
      expires: cookie.expires?.toISOString(),
    }),
  ) + 1;

const isExpired = (cookie: Cookie, now: number): boolean =>
  cookie.expires instanceof Date && cookie.expires.getTime() <= now;

const mergeBoundedCookies = (current: readonly Cookie[], incoming: readonly Cookie[]): Cookie[] => {
  const entries = new Map<string, { cookie: Cookie; weight: number }>();
  const now = Date.now();
  let totalBytes = 2;

  const apply = (candidate: Cookie): void => {
    if (!isQiMangaCookie(candidate)) return;
    const cookie = canonicalCookie(candidate);
    const identifier = cookieIdentifier(cookie);
    const previous = entries.get(identifier);
    if (isExpired(cookie, now)) {
      if (previous) {
        entries.delete(identifier);
        totalBytes -= previous.weight;
      }
      return;
    }

    const weight = cookieWeight(cookie);
    const nextCount = entries.size + (previous ? 0 : 1);
    const nextBytes = totalBytes - (previous?.weight ?? 0) + weight;
    if (nextCount > MAX_QIMANGA_COOKIE_COUNT || nextBytes > MAX_QIMANGA_COOKIE_BYTES) return;
    entries.set(identifier, { cookie, weight });
    totalBytes = nextBytes;
  };

  for (const cookie of current) apply(cookie);
  for (const cookie of incoming) apply(cookie);
  return [...entries.values()].map(({ cookie }) => cookie);
};

/** Bound even deletion directives before the stock interceptor examines a response cookie array. */
const limitCookieDirectives = (cookies: readonly Cookie[]): Cookie[] => {
  const entries = new Map<string, { cookie: Cookie; weight: number }>();
  const maximum = Math.min(cookies.length, MAX_QIMANGA_COOKIE_CANDIDATES);
  let totalBytes = 2;
  for (let index = 0; index < maximum; index += 1) {
    const candidate = cookies[index];
    if (!candidate || !isQiMangaCookie(candidate)) continue;
    const cookie = canonicalCookie(candidate);
    const identifier = cookieIdentifier(cookie);
    const previous = entries.get(identifier);
    const weight = cookieWeight(cookie);
    const nextCount = entries.size + (previous ? 0 : 1);
    const nextBytes = totalBytes - (previous?.weight ?? 0) + weight;
    if (nextCount > MAX_QIMANGA_COOKIE_COUNT || nextBytes > MAX_QIMANGA_COOKIE_BYTES) continue;
    entries.set(identifier, { cookie, weight });
    totalBytes = nextBytes;
  }
  return [...entries.values()].map(({ cookie }) => cookie);
};

const boundStoredCookieState = (): void => {
  if (typeof Application === "undefined") return;
  const stored = Application.getSecureState(QIMANGA_COOKIE_STATE_KEY);
  if (!Array.isArray(stored)) return;
  const candidates: Cookie[] = [];
  const maximum = Math.min(stored.length, MAX_QIMANGA_COOKIE_CANDIDATES);
  for (let index = 0; index < maximum; index += 1) {
    const cookie = deserializeCookie(stored[index]);
    if (cookie) candidates.push(cookie);
  }
  Application.setSecureState(mergeBoundedCookies([], candidates), QIMANGA_COOKIE_STATE_KEY);
};

/**
 * Keep caller cookies on Qi Manga's account-bearing origins. Reader CDNs and
 * the fixed public fallback icon stay cookie-neutral.
 */
export class QiMangaCookieInterceptor
  extends SecureCookieInterceptor
  implements QiMangaCookieStore
{
  private authenticationGeneration = 0;
  private authenticationCookiesBlocked = false;

  constructor() {
    // Secure state is untrusted persisted input, so bound it before the shared
    // interceptor deserializes and republishes the cookie jar.
    boundStoredCookieState();
    super({
      stateKey: QIMANGA_COOKIE_STATE_KEY,
      generationHeader: GENERATION_HEADER,
      isTrustedRequestUrl: isTrustedCookieRequestUrl,
      isAcceptedCookie: isQiMangaCookie,
      isSensitiveCookieName: isQiMangaAuthCookieName,
      shouldStripCookieName: () => true,
    });
    this.enforceLimits();
  }

  get authCookieGeneration(): number {
    return this.authenticationGeneration;
  }

  override setCookie(cookie: Cookie): void {
    this.setCookies([cookie]);
  }

  setCookies(cookies: readonly Cookie[]): void {
    const candidates = limitCookieDirectives(cookies).filter(
      (cookie) => !this.authenticationCookiesBlocked || !isQiMangaAuthCookieName(cookie.name),
    );
    this.cookies = mergeBoundedCookies(this.cookies, candidates);
    this.persistCurrentCookies();
  }

  override async interceptResponse(
    request: Request,
    response: Response,
    data: ArrayBuffer,
  ): Promise<ArrayBuffer> {
    const result = await super.interceptResponse(
      request,
      { ...response, cookies: limitCookieDirectives(response.cookies) },
      data,
    );
    this.enforceLimits();
    return result;
  }

  override invalidateSensitiveCookies(): void {
    this.authenticationCookiesBlocked = true;
    super.invalidateSensitiveCookies();
    this.authenticationGeneration += 1;
  }

  override acceptSensitiveCookies(): void {
    super.acceptSensitiveCookies();
    this.authenticationCookiesBlocked = false;
    this.authenticationGeneration += 1;
  }

  invalidateAuthCookies(): void {
    this.invalidateSensitiveCookies();
  }

  acceptAuthCookies(): void {
    this.acceptSensitiveCookies();
  }

  private enforceLimits(): void {
    this.cookies = mergeBoundedCookies([], this.cookies);
    this.persistCurrentCookies();
  }

  private persistCurrentCookies(): void {
    if (typeof Application !== "undefined") {
      Application.setSecureState([...this.cookies], QIMANGA_COOKIE_STATE_KEY);
    }
  }
}
