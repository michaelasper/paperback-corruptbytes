import {
  CookieStorageInterceptor,
  URL as PaperbackURL,
  type Cookie,
  type Request,
  type Response,
} from "@paperback/types";

import { headerValue } from "./http.js";

export interface SecureCookieInterceptorOptions {
  stateKey: string;
  generationHeader: string;
  isTrustedRequestUrl(value: string): boolean;
  isAcceptedCookie(cookie: Cookie): boolean;
  isSensitiveCookieName(name: string): boolean;
  shouldStripCookieName?(name: string): boolean;
}

const storedDate = (input: unknown): Date | undefined => {
  if (input instanceof Date) return Number.isNaN(input.getTime()) ? undefined : input;
  if (typeof input !== "string" && typeof input !== "number") return undefined;
  const parsed = new Date(input);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
};

const domainFromCookie = (cookie: Cookie): string =>
  cookie.domain.trim().replace(/^\.+/, "").toLowerCase();

const responseHost = (url: string): string | undefined => {
  try {
    const parsed = new PaperbackURL(url);
    return parsed.protocol.toLowerCase().replace(/:$/, "") === "https"
      ? parsed.hostname.toLowerCase()
      : undefined;
  } catch {
    return undefined;
  }
};

const cookieMatchesResponseOrigin = (responseUrl: string, cookie: Cookie): boolean => {
  const hostname = responseHost(responseUrl);
  const domain = domainFromCookie(cookie);
  return Boolean(hostname && domain && (hostname === domain || hostname.endsWith(`.${domain}`)));
};

const deserializeCookies = (options: SecureCookieInterceptorOptions): Cookie[] => {
  if (typeof Application === "undefined") return [];
  const value = Application.getSecureState(options.stateKey);
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
    return options.isAcceptedCookie(cookie) ? [cookie] : [];
  });
};

/**
 * Persistent, source-scoped cookie storage with stale-response protection.
 * Session cookies are kept in secure state because Paperback's stock
 * persistent jar intentionally omits them.
 */
export class SecureCookieInterceptor extends CookieStorageInterceptor {
  private generation = 0;
  private sensitiveCookiesBlocked = false;

  constructor(private readonly secureOptions: SecureCookieInterceptorOptions) {
    super({ storage: "memory" });
    this.cookies = deserializeCookies(secureOptions);
    this.persist();
  }

  override setCookie(cookie: Cookie): void {
    if (!this.secureOptions.isAcceptedCookie(cookie)) return;
    if (this.sensitiveCookiesBlocked && this.secureOptions.isSensitiveCookieName(cookie.name)) {
      return;
    }
    super.setCookie(cookie);
    this.persist();
  }

  override deleteCookie(cookie: Cookie): void {
    super.deleteCookie(cookie);
    this.persist();
  }

  invalidateSensitiveCookies(): void {
    this.generation += 1;
    this.sensitiveCookiesBlocked = true;
    for (const cookie of this.cookies) {
      if (this.secureOptions.isSensitiveCookieName(cookie.name)) super.deleteCookie(cookie);
    }
    this.persist();
  }

  acceptSensitiveCookies(): void {
    this.generation += 1;
    this.sensitiveCookiesBlocked = false;
  }

  override async interceptRequest(request: Request): Promise<Request> {
    if (!this.secureOptions.isTrustedRequestUrl(request.url)) {
      request.cookies = Object.fromEntries(
        Object.entries(request.cookies ?? {}).filter(
          ([name]) =>
            !(
              this.secureOptions.shouldStripCookieName?.(name) ??
              this.secureOptions.isSensitiveCookieName(name)
            ),
        ),
      );
      return request;
    }

    const intercepted = await super.interceptRequest(request);
    intercepted.headers = {
      ...intercepted.headers,
      [this.secureOptions.generationHeader]: String(this.generation),
    };
    return intercepted;
  }

  override async interceptResponse(
    request: Request,
    response: Response,
    data: ArrayBuffer,
  ): Promise<ArrayBuffer> {
    const responseUrl = response.url || request.url;
    const marker = headerValue(request.headers, this.secureOptions.generationHeader);
    const requestGeneration = Number(marker);
    const generationMatches =
      Number.isFinite(requestGeneration) && requestGeneration === this.generation;
    const acceptsSensitiveCookies =
      !this.sensitiveCookiesBlocked &&
      (generationMatches || (this.generation === 0 && marker === undefined));
    const trustedOrigins =
      this.secureOptions.isTrustedRequestUrl(request.url) &&
      this.secureOptions.isTrustedRequestUrl(responseUrl);

    const trustedResponse: Response = {
      ...response,
      cookies: trustedOrigins
        ? response.cookies.filter(
            (cookie) =>
              this.secureOptions.isAcceptedCookie(cookie) &&
              cookieMatchesResponseOrigin(responseUrl, cookie) &&
              (!this.secureOptions.isSensitiveCookieName(cookie.name) || acceptsSensitiveCookies),
          )
        : [],
    };
    const result = await super.interceptResponse(request, trustedResponse, data);
    this.cookies = [...this.cookies].filter((cookie) =>
      this.secureOptions.isAcceptedCookie(cookie),
    );
    this.persist();
    return result;
  }

  private persist(): void {
    if (typeof Application !== "undefined") {
      Application.setSecureState([...this.cookies], this.secureOptions.stateKey);
    }
  }
}
