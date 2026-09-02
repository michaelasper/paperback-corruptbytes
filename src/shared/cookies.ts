import {
  CookieStorageInterceptor,
  URL as PaperbackURL,
  type Cookie,
  type Request,
  type Response,
} from "@paperback/types";

import { utf8ByteLength } from "./async-cache.js";
import { headerValue } from "./http.js";

const DEFAULT_MAX_COOKIE_COUNT = 64;
const DEFAULT_MAX_COOKIE_BYTES = 128 * 1_024;
const MAX_COOKIE_INSPECTION = 1_024;

export interface SecureCookieInterceptorOptions {
  stateKey: string;
  generationHeader: string;
  isTrustedRequestUrl(value: string): boolean;
  isAcceptedCookie(cookie: Cookie): boolean;
  isSensitiveCookieName(name: string): boolean;
  shouldStripCookieName?(name: string): boolean;
  /** Maximum number of source-scoped cookies retained in memory and secure state. */
  maxCookieCount?: number;
  /** Aggregate byte budget for retained cookie fields, including conservative metadata overhead. */
  maxCookieBytes?: number;
}

const currentTimestamp = (): number => {
  try {
    const value = Date.now();
    return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
};

const dateTimestamp = (input: unknown): number | undefined => {
  try {
    if (!(input instanceof Date)) return undefined;
    const timestamp = Date.prototype.getTime.call(input) as number;
    return Number.isFinite(timestamp) ? timestamp : undefined;
  } catch {
    return undefined;
  }
};

const storedDate = (input: unknown): Date | undefined => {
  const timestamp =
    typeof input === "string" || typeof input === "number"
      ? dateTimestamp(new Date(input))
      : dateTimestamp(input);
  return timestamp === undefined ? undefined : new Date(timestamp);
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

const cookieIdentifier = (cookie: Cookie): string => {
  const domain = cookie.domain.trim().replace(/^\.+/, "").toLowerCase();
  const path = cookie.path?.startsWith("/") ? cookie.path : `/${cookie.path ?? ""}`;
  return JSON.stringify([cookie.name, domain, path]);
};

// Paperback's stock jar strips a bare leading `www.` while forming its private
// key. Prefixing that one canonical form with a dot preserves the actual label;
// leading-dot and non-leading-dot Domain attributes are equivalent for matching.
const cookieForPaperbackStorage = (cookie: Cookie): Cookie => {
  const domain = domainFromCookie(cookie);
  const storedDomain =
    domain.startsWith("www.") && !cookie.domain.startsWith(".") ? `.${domain}` : cookie.domain;
  const created = storedDate(cookie.created);
  const expires = storedDate(cookie.expires);
  return {
    name: cookie.name,
    value: cookie.value,
    domain: storedDomain,
    ...(typeof cookie.path === "string" && { path: cookie.path }),
    ...(created && { created }),
    ...(expires && { expires }),
  };
};

// Include generous fixed overhead for JSON keys, delimiters, and serialized dates so
// the configured byte budget is an upper bound rather than just a value-length sum.
const cookieWeight = (cookie: Cookie): number =>
  192 +
  utf8ByteLength(cookie.name) +
  utf8ByteLength(cookie.value) +
  utf8ByteLength(cookie.domain) +
  utf8ByteLength(cookie.path ?? "");

const isExpired = (cookie: Cookie, now: number): boolean => {
  if (cookie.expires === undefined) return false;
  const expires = dateTimestamp(cookie.expires);
  return expires === undefined || expires <= now;
};

const inspectionLimit = (options: SecureCookieInterceptorOptions): number => {
  const retainedEstimate =
    options.maxCookieCount ??
    Math.max(1, Math.ceil((options.maxCookieBytes ?? DEFAULT_MAX_COOKIE_BYTES) / 192));
  return Math.min(MAX_COOKIE_INSPECTION, Math.max(retainedEstimate, retainedEstimate * 16));
};

const boundedArrayValues = (value: unknown, maximum: number): unknown[] => {
  try {
    if (!Array.isArray(value)) return [];
    const length = value.length;
    if (!Number.isSafeInteger(length) || length < 0) return [];
    const result: unknown[] = [];
    for (let index = 0; index < length && index < maximum; index += 1) {
      try {
        result.push(value[index]);
      } catch {
        // Skip a throwing array member and continue within the inspection ceiling.
      }
    }
    return result;
  } catch {
    return [];
  }
};

const hasUnpairedSurrogate = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }
  return false;
};

const containsControlCharacter = (value: string): boolean => {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) return true;
  }
  return false;
};

const isCookieOctetValue = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (
      code !== 0x21 &&
      !(code >= 0x23 && code <= 0x2b) &&
      !(code >= 0x2d && code <= 0x3a) &&
      !(code >= 0x3c && code <= 0x5b) &&
      !(code >= 0x5d && code <= 0x7e)
    ) {
      return false;
    }
  }
  return true;
};

/** Read a runtime cookie once and retain only Paperback's declared, safe fields. */
const cookieSnapshot = (value: unknown): Cookie | undefined => {
  try {
    if (!value || typeof value !== "object") return undefined;
    const candidate = value as Partial<Cookie>;
    const name = candidate.name;
    const cookieValue = candidate.value;
    const domain = candidate.domain;
    const path = candidate.path;
    const created = candidate.created;
    const expires = candidate.expires;
    if (
      typeof name !== "string" ||
      name.length < 1 ||
      name.length > 256 ||
      !/^[!#$%&'*+\-.^_`|~\dA-Za-z]+$/.test(name) ||
      typeof cookieValue !== "string" ||
      cookieValue.length > 16 * 1_024 ||
      !isCookieOctetValue(cookieValue) ||
      typeof domain !== "string" ||
      domain.length < 1 ||
      domain.length > 253 ||
      domain !== domain.trim() ||
      domain.startsWith("..") ||
      containsControlCharacter(domain) ||
      hasUnpairedSurrogate(domain) ||
      (path !== undefined &&
        (typeof path !== "string" ||
          !path.startsWith("/") ||
          path.length > 2_048 ||
          containsControlCharacter(path) ||
          hasUnpairedSurrogate(path)))
    ) {
      return undefined;
    }
    const createdTimestamp = created === undefined ? undefined : dateTimestamp(created);
    const expiresTimestamp = expires === undefined ? undefined : dateTimestamp(expires);
    if (
      (created !== undefined && createdTimestamp === undefined) ||
      (expires !== undefined && expiresTimestamp === undefined)
    ) {
      return undefined;
    }
    return {
      name,
      value: cookieValue,
      domain,
      ...(path !== undefined && { path }),
      ...(createdTimestamp !== undefined && { created: new Date(createdTimestamp) }),
      ...(expiresTimestamp !== undefined && { expires: new Date(expiresTimestamp) }),
    };
  } catch {
    return undefined;
  }
};

const acceptsCookie = (options: SecureCookieInterceptorOptions, cookie: Cookie): boolean => {
  try {
    return options.isAcceptedCookie(cookie) === true;
  } catch {
    return false;
  }
};

const isSensitiveCookie = (options: SecureCookieInterceptorOptions, name: string): boolean => {
  try {
    return options.isSensitiveCookieName(name) !== false;
  } catch {
    return true;
  }
};

const isTrustedRequest = (options: SecureCookieInterceptorOptions, url: string): boolean => {
  try {
    return options.isTrustedRequestUrl(url) === true;
  } catch {
    return false;
  }
};

const shouldStripCookie = (options: SecureCookieInterceptorOptions, name: string): boolean => {
  if (!options.shouldStripCookieName) return isSensitiveCookie(options, name);
  try {
    return options.shouldStripCookieName(name) !== false;
  } catch {
    return true;
  }
};

const sanitizedCallerCookies = (
  value: unknown,
  options: SecureCookieInterceptorOptions,
): Record<string, string> => {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const source = value as Record<string, unknown>;
    const cookies: Record<string, string> = {};
    let inspected = 0;
    let totalBytes = 0;
    for (const name in source) {
      inspected += 1;
      if (inspected > MAX_COOKIE_INSPECTION) break;
      if (!Object.prototype.hasOwnProperty.call(source, name)) continue;
      const cookieValue = source[name];
      if (
        name.length < 1 ||
        name.length > 256 ||
        !/^[!#$%&'*+\-.^_`|~\dA-Za-z]+$/.test(name) ||
        typeof cookieValue !== "string" ||
        cookieValue.length > 16 * 1_024 ||
        !isCookieOctetValue(cookieValue) ||
        shouldStripCookie(options, name)
      ) {
        continue;
      }
      const weight = 192 + utf8ByteLength(name) + utf8ByteLength(cookieValue);
      if (
        Object.keys(cookies).length >= DEFAULT_MAX_COOKIE_COUNT ||
        totalBytes + weight > DEFAULT_MAX_COOKIE_BYTES
      ) {
        continue;
      }
      cookies[name] = cookieValue;
      totalBytes += weight;
    }
    return cookies;
  } catch {
    return {};
  }
};

/** Merge replacements/deletions while refusing additions that exceed either aggregate bound. */
const mergeBoundedCookies = (
  current: readonly Cookie[],
  incoming: readonly Cookie[],
  options: SecureCookieInterceptorOptions,
): Cookie[] => {
  const maxCount = options.maxCookieCount ?? DEFAULT_MAX_COOKIE_COUNT;
  const maxBytes = options.maxCookieBytes ?? DEFAULT_MAX_COOKIE_BYTES;
  const entries = new Map<string, { cookie: Cookie; weight: number }>();
  const now = currentTimestamp();
  let totalBytes = 0;

  const apply = (value: unknown): void => {
    try {
      const cookie = cookieSnapshot(value);
      if (!cookie || !acceptsCookie(options, cookie)) return;
      const storedCookie = cookieForPaperbackStorage(cookie);
      const identifier = cookieIdentifier(storedCookie);
      const previous = entries.get(identifier);
      if (isExpired(storedCookie, now)) {
        if (previous) {
          entries.delete(identifier);
          totalBytes -= previous.weight;
        }
        return;
      }

      const weight = cookieWeight(storedCookie);
      const nextCount = entries.size + (previous ? 0 : 1);
      const nextBytes = totalBytes - (previous?.weight ?? 0) + weight;
      if (nextCount > maxCount || nextBytes > maxBytes) return;
      if (previous) entries.delete(identifier);
      entries.set(identifier, { cookie: storedCookie, weight });
      totalBytes = nextBytes;
    } catch {
      // Runtime cookie bridges can return malformed objects despite static types.
    }
  };

  const maximumInspected = inspectionLimit(options);
  for (const candidate of boundedArrayValues(current, maximumInspected)) apply(candidate);
  for (const candidate of boundedArrayValues(incoming, maximumInspected)) apply(candidate);
  return [...entries.values()].map(({ cookie }) => cookie);
};

const deserializeCookies = (options: SecureCookieInterceptorOptions): Cookie[] => {
  if (typeof Application === "undefined") return [];
  let value: unknown;
  try {
    value = Application.getSecureState(options.stateKey);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];

  const cookies: Cookie[] = [];
  const maximumInspected = inspectionLimit(options);
  for (const candidate of boundedArrayValues(value, maximumInspected)) {
    try {
      if (!candidate || typeof candidate !== "object") continue;
      const raw = candidate as Partial<Cookie> & { created?: unknown; expires?: unknown };
      if (
        typeof raw.name !== "string" ||
        typeof raw.value !== "string" ||
        typeof raw.domain !== "string"
      ) {
        continue;
      }

      const expires = storedDate(raw.expires);
      if (raw.expires !== undefined && !expires) continue;
      const created = storedDate(raw.created);
      if (raw.created !== undefined && !created) continue;
      cookies.push({
        name: raw.name,
        value: raw.value,
        domain: raw.domain,
        ...(typeof raw.path === "string" && { path: raw.path }),
        ...(created && { created }),
        ...(expires && { expires }),
      });
    } catch {
      // Ignore malformed secure-state members and continue restoring bounded state.
    }
  }
  return mergeBoundedCookies([], cookies, options);
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
    if (
      typeof secureOptions.generationHeader !== "string" ||
      secureOptions.generationHeader.length < 1 ||
      secureOptions.generationHeader.length > 256 ||
      !/^[!#$%&'*+\-.^_`|~\dA-Za-z]+$/.test(secureOptions.generationHeader)
    ) {
      throw new Error("Secure cookie generation header must be a valid HTTP token.");
    }
    if (
      secureOptions.maxCookieCount !== undefined &&
      (!Number.isSafeInteger(secureOptions.maxCookieCount) || secureOptions.maxCookieCount < 1)
    ) {
      throw new Error("Secure cookie count limit must be a positive safe integer.");
    }
    if (
      secureOptions.maxCookieBytes !== undefined &&
      (!Number.isSafeInteger(secureOptions.maxCookieBytes) || secureOptions.maxCookieBytes < 1)
    ) {
      throw new Error("Secure cookie byte limit must be a positive safe integer.");
    }
    this.cookies = deserializeCookies(secureOptions);
    this.persist();
  }

  setCookies(cookies: readonly Cookie[]): void {
    const maximumInspected = inspectionLimit(this.secureOptions);
    const candidates = boundedArrayValues(cookies, maximumInspected).flatMap((value): Cookie[] => {
      const cookie = cookieSnapshot(value);
      if (!cookie) return [];
      try {
        return acceptsCookie(this.secureOptions, cookie) &&
          (!this.sensitiveCookiesBlocked || !isSensitiveCookie(this.secureOptions, cookie.name))
          ? [cookie]
          : [];
      } catch {
        return [];
      }
    });
    this.cookies = mergeBoundedCookies(this.cookies, candidates, this.secureOptions);
    this.persist();
  }

  override setCookie(cookie: Cookie): void {
    this.setCookies([cookie]);
  }

  override deleteCookie(cookie: Cookie): void {
    try {
      const snapshot = cookieSnapshot(cookie);
      if (!snapshot) return;
      super.deleteCookie(cookieForPaperbackStorage(snapshot));
    } catch {
      // Runtime cookie bridges can expose malformed members despite static types.
    }
    this.persist();
  }

  invalidateSensitiveCookies(): void {
    this.generation += 1;
    this.sensitiveCookiesBlocked = true;
    for (const cookie of this.cookies) {
      if (isSensitiveCookie(this.secureOptions, cookie.name)) super.deleteCookie(cookie);
    }
    this.persist();
  }

  acceptSensitiveCookies(): void {
    this.generation += 1;
    this.sensitiveCookiesBlocked = false;
  }

  get sensitiveCookieGeneration(): number {
    return this.generation;
  }

  override async interceptRequest(request: Request): Promise<Request> {
    if (!isTrustedRequest(this.secureOptions, request.url)) {
      let callerCookies: unknown;
      try {
        callerCookies = request.cookies;
      } catch {
        // A malformed caller cookie map fails toward stripping every cookie.
      }
      const cookies = sanitizedCallerCookies(callerCookies, this.secureOptions);
      const hasCookies = Object.keys(cookies).length > 0;
      // Paperback invokes request interceptors with the same original object and uses
      // only the final return value. Sanitize that shared object as well as our clone.
      try {
        if (hasCookies) request.cookies = cookies;
        else delete request.cookies;
      } catch {
        // Frozen or hostile request objects are still sanitized in the returned clone.
      }
      const intercepted = { ...request };
      if (hasCookies) intercepted.cookies = cookies;
      else delete intercepted.cookies;
      return intercepted;
    }

    // Bind the generation before CookieStorageInterceptor's promise yields. Its
    // implementation injects cookies synchronously, so the marker must identify
    // that same credential snapshot even if authentication changes immediately.
    const requestGeneration = this.generation;
    const intercepted = await super.interceptRequest(request);
    const generationHeader = this.secureOptions.generationHeader;
    let headers: Record<string, string> = {};
    try {
      headers = Object.fromEntries(
        Object.entries(intercepted.headers ?? {}).filter(
          ([name, value]) =>
            typeof value === "string" && name.toLowerCase() !== generationHeader.toLowerCase(),
        ),
      );
    } catch {
      // A malformed runtime header map retains no caller-controlled values.
    }
    headers[generationHeader] = String(requestGeneration);
    intercepted.headers = headers;
    return intercepted;
  }

  override async interceptResponse(
    request: Request,
    response: Response,
    data: ArrayBuffer,
  ): Promise<ArrayBuffer> {
    let requestUrl: string | undefined;
    let responseUrl: string | undefined;
    let marker: string | undefined;
    try {
      const value = request.url;
      requestUrl = typeof value === "string" && value ? value : undefined;
    } catch {
      // A malformed request URL can never authorize cookie persistence.
    }
    try {
      const value = response.url;
      responseUrl = typeof value === "string" && value ? value : undefined;
    } catch {
      // A malformed response URL can never authorize cookie persistence.
    }
    try {
      marker = headerValue(request.headers, this.secureOptions.generationHeader);
    } catch {
      // A malformed request header map never supplies a generation marker.
    }
    const requestGeneration = Number(marker);
    const generationMatches =
      marker !== undefined &&
      marker === String(requestGeneration) &&
      Number.isSafeInteger(requestGeneration) &&
      requestGeneration >= 0 &&
      requestGeneration === this.generation;
    const acceptsSensitiveCookies = !this.sensitiveCookiesBlocked && generationMatches;
    const trustedOrigins =
      requestUrl !== undefined &&
      responseUrl !== undefined &&
      isTrustedRequest(this.secureOptions, requestUrl) &&
      isTrustedRequest(this.secureOptions, responseUrl);

    const acceptedResponseCookies: Cookie[] = [];
    if (trustedOrigins) {
      const trustedResponseUrl = responseUrl as string;
      const maximumInspected = inspectionLimit(this.secureOptions);
      let responseCookies: unknown = [];
      try {
        responseCookies = response.cookies;
      } catch {
        // Treat a malformed runtime cookie collection as empty.
      }
      for (const value of boundedArrayValues(responseCookies, maximumInspected)) {
        const cookie = cookieSnapshot(value);
        if (!cookie) continue;
        try {
          if (
            acceptsCookie(this.secureOptions, cookie) &&
            cookieMatchesResponseOrigin(trustedResponseUrl, cookie) &&
            (!isSensitiveCookie(this.secureOptions, cookie.name) || acceptsSensitiveCookies)
          ) {
            acceptedResponseCookies.push(cookie);
          }
        } catch {
          // Reject malformed runtime cookie members without invoking later validators.
        }
      }
    }
    this.cookies = mergeBoundedCookies(this.cookies, acceptedResponseCookies, this.secureOptions);
    this.persist();
    return data;
  }

  private persist(): void {
    if (typeof Application === "undefined") return;
    try {
      Application.setSecureState([...this.cookies], this.secureOptions.stateKey);
    } catch {
      // Keep the bounded in-memory jar usable when secure storage is unavailable.
    }
  }
}
