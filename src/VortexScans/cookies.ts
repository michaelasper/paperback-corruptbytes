import {
  CookieStorageInterceptor,
  type Cookie,
  type Request,
  type Response,
} from "@paperback/types";

import { isVortexAuthCookie, isVortexAuthCookieName, isVortexCookie } from "./auth.js";

export const VORTEX_COOKIE_STATE_KEY = "vortex_scans.secure_cookies";
const AUTH_GENERATION_HEADER = "x-paperback-vortex-cookie-generation";
const COOKIE_HOSTS = new Set([
  "vortexscans.org",
  "www.vortexscans.org",
  "api.vortexscans.org",
  "dashboard.vortexscans.org",
]);

const storedDate = (input: unknown): Date | undefined => {
  if (input instanceof Date) return Number.isNaN(input.getTime()) ? undefined : input;
  if (typeof input !== "string" && typeof input !== "number") return undefined;
  const parsed = new Date(input);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
};

const storedCookies = (): Cookie[] => {
  const value = Application.getSecureState(VORTEX_COOKIE_STATE_KEY);
  if (!Array.isArray(value)) return [];

  return value.flatMap((candidate): Cookie[] => {
    if (!candidate || typeof candidate !== "object") return [];
    const raw = candidate as Partial<Cookie> & { created?: unknown; expires?: unknown };
    if (
      typeof raw.name !== "string" ||
      typeof raw.value !== "string" ||
      typeof raw.domain !== "string"
    ) {
      return [];
    }

    const expires = storedDate(raw.expires);
    if (raw.expires != null && !expires) return [];
    const created = storedDate(raw.created);
    const cookie: Cookie = {
      name: raw.name,
      value: raw.value,
      domain: raw.domain,
      ...(typeof raw.path === "string" && { path: raw.path }),
      ...(created && { created }),
      ...(expires && { expires }),
    };
    return isVortexCookie(cookie) ? [cookie] : [];
  });
};

const sanitizedDomain = (domain: string): string => domain.trim().replace(/^\.+/, "").toLowerCase();

const trustedCookieUrl = (value: string): URL | undefined => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && COOKIE_HOSTS.has(url.hostname.toLowerCase())
      ? url
      : undefined;
  } catch {
    return undefined;
  }
};

const headerValue = (
  headers: Record<string, string> | undefined,
  name: string,
): string | undefined =>
  Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];

const cookieMatchesResponseOrigin = (responseUrl: string, cookie: Cookie): boolean => {
  if (!isVortexCookie(cookie)) return false;

  try {
    const hostname = trustedCookieUrl(responseUrl)?.hostname.toLowerCase();
    if (!hostname) return false;
    const domain = sanitizedDomain(cookie.domain);
    return hostname === domain || hostname.endsWith(`.${domain}`);
  } catch {
    return false;
  }
};

/**
 * A source-scoped cookie jar. Paperback's stock persistent jar uses one shared
 * state key and drops session cookies; VortexCookieInterceptor keeps only
 * first-party Vortex cookies in this extension's secure state instead.
 */
export class VortexCookieInterceptor extends CookieStorageInterceptor {
  private authGeneration = 0;
  private authCookiesBlocked = false;

  constructor() {
    super({ storage: "memory" });
    this.cookies = storedCookies();
    this.persist();
  }

  override setCookie(cookie: Cookie): void {
    if (!isVortexCookie(cookie)) return;
    if (this.authCookiesBlocked && isVortexAuthCookie(cookie)) return;
    super.setCookie(cookie);
    this.persist();
  }

  override deleteCookie(cookie: Cookie): void {
    super.deleteCookie(cookie);
    this.persist();
  }

  invalidateAuthCookies(): void {
    this.authGeneration += 1;
    this.authCookiesBlocked = true;
    for (const cookie of this.cookies) {
      if (isVortexAuthCookie(cookie)) super.deleteCookie(cookie);
    }
    this.persist();
  }

  acceptAuthCookies(): void {
    this.authGeneration += 1;
    this.authCookiesBlocked = false;
  }

  override async interceptRequest(request: Request): Promise<Request> {
    if (!trustedCookieUrl(request.url)) {
      const cookies = Object.fromEntries(
        Object.entries(request.cookies ?? {}).filter(([name]) => !isVortexAuthCookieName(name)),
      );
      // Later interceptors receive this original object, so removing a
      // sensitive caller-provided cookie must happen in place as well.
      request.cookies = cookies;
      return request;
    }

    const intercepted = await super.interceptRequest(request);
    // Paperback's current pipeline passes the original Request to every
    // interceptor, so this marker must be applied in place to survive the
    // subsequent header interceptor. It contains no session material.
    intercepted.headers = {
      ...intercepted.headers,
      [AUTH_GENERATION_HEADER]: String(this.authGeneration),
    };
    return intercepted;
  }

  override async interceptResponse(
    request: Request,
    response: Response,
    data: ArrayBuffer,
  ): Promise<ArrayBuffer> {
    const responseUrl = response.url || request.url;
    const requestGeneration = Number(headerValue(request.headers, AUTH_GENERATION_HEADER));
    const generationMatches =
      Number.isFinite(requestGeneration) && requestGeneration === this.authGeneration;
    const acceptsAuthCookies =
      !this.authCookiesBlocked &&
      (generationMatches ||
        (this.authGeneration === 0 &&
          headerValue(request.headers, AUTH_GENERATION_HEADER) === undefined));
    const trustsRequest = Boolean(trustedCookieUrl(request.url));
    const trustedResponse: Response = {
      ...response,
      cookies: trustsRequest
        ? response.cookies.filter(
            (cookie) =>
              cookieMatchesResponseOrigin(responseUrl, cookie) &&
              (!isVortexAuthCookie(cookie) || acceptsAuthCookies),
          )
        : [],
    };
    const result = await super.interceptResponse(request, trustedResponse, data);
    this.cookies = [...this.cookies].filter(isVortexCookie);
    this.persist();
    return result;
  }

  private persist(): void {
    Application.setSecureState([...this.cookies], VORTEX_COOKIE_STATE_KEY);
  }
}
