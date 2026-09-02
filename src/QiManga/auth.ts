import { URL as PaperbackURL, type Cookie, type Request } from "@paperback/types";

import { utf8ByteLength } from "../shared/async-cache.js";
import {
  assertResponseBodyWithinLimit,
  CloudflareError,
  decodeResponseBody,
  responseStatus,
  scheduleBoundedResponse,
  SourceHttpError,
} from "../shared/http.js";
import { isHttpsUrlForHosts } from "../shared/url.js";
import { API_BASE_URL, DOMAIN, fetchText, isApiRequestUrl } from "./network.js";

export const ACCOUNT_URL = `${API_BASE_URL}/users/me`;
export const REFRESH_URL = `${API_BASE_URL}/auth/refresh`;
export const SIGN_OUT_URL = `${API_BASE_URL}/auth/logout`;
export const QIMANGA_COOKIE_GENERATION_HEADER = "x-paperback-qimanga-cookie-generation";

export interface QiMangaCookieStore {
  readonly cookies: Readonly<Cookie[]>;
  setCookie(cookie: Cookie): void;
  setCookies?(cookies: readonly Cookie[]): void;
  deleteCookie(cookie: Cookie): void;
  invalidateAuthCookies?(): void;
  acceptAuthCookies?(): void;
  readonly sensitiveCookieGeneration: number;
}

export interface QiMangaAccountStatus {
  authenticated: boolean;
  displayName?: string;
}

const API_HOSTS = new Set(["api.qimanga.com"]);
const ACCOUNT_RESPONSE_OPTIONS = {
  sourceName: "Qi Manga account",
  maxBodyBytes: 256 * 1_024,
  isResponseUrlAllowed: (requestUrl: string, responseUrl: string) =>
    isApiRequestUrl(requestUrl) && isApiRequestUrl(responseUrl),
} as const;
const REFRESH_RESPONSE_OPTIONS = {
  sourceName: "Qi Manga session refresh",
  maxBodyBytes: 256 * 1_024,
  isResponseUrlAllowed: ACCOUNT_RESPONSE_OPTIONS.isResponseUrlAllowed,
} as const;
const SIGN_OUT_RESPONSE_OPTIONS = {
  sourceName: "Qi Manga logout",
  maxBodyBytes: 256 * 1_024,
  isResponseUrlAllowed: ACCOUNT_RESPONSE_OPTIONS.isResponseUrlAllowed,
} as const;
const SIGN_OUT_TIMEOUT_MS = 5_000;
const REFRESH_TIMEOUT_MS = 15_000;
const MAX_HEADER_INPUTS = 256;
const MAX_COOKIE_INPUTS = 1_024;
const MAX_COOKIE_COUNT = 64;
const MAX_COOKIE_BYTES = 128 * 1_024;
const SAFE_TRANSPORT_ERROR =
  /^Qi Manga(?: account| session refresh| logout)? response (?:URL was not trusted|was too large to process safely)\.$/;
const SAFE_HTTP_SOURCES = new Set([
  "Qi Manga",
  "Qi Manga account",
  "Qi Manga session refresh",
  "Qi Manga logout",
]);
interface ActiveRefresh {
  generation: number | undefined;
  promise: Promise<number | undefined>;
}

const refreshRequests = new WeakMap<QiMangaCookieStore, ActiveRefresh>();

const sensitiveGeneration = (store: QiMangaCookieStore): number | undefined => {
  try {
    const generation = store.sensitiveCookieGeneration;
    return typeof generation === "number" && Number.isSafeInteger(generation) && generation >= 0
      ? generation
      : undefined;
  } catch {
    return undefined;
  }
};

const generationMatches = (store: QiMangaCookieStore, expected: number | undefined): boolean =>
  expected !== undefined && sensitiveGeneration(store) === expected;

const isSuccessfulHttpStatus = (status: unknown): status is number =>
  typeof status === "number" && Number.isSafeInteger(status) && status >= 200 && status < 300;

const safeTransportError = (error: unknown): Error => {
  try {
    if (error instanceof SourceHttpError) {
      const sourceName = SAFE_HTTP_SOURCES.has(error.sourceName) ? error.sourceName : "Qi Manga";
      return new SourceHttpError(sourceName, error.status);
    }
    if (error instanceof CloudflareError) {
      return new CloudflareError(
        { url: DOMAIN, method: "GET" },
        "Cloudflare verification is required to access Qi Manga.",
      );
    }
    if (error instanceof Error && SAFE_TRANSPORT_ERROR.test(error.message)) {
      return new Error(error.message);
    }
  } catch {
    // Hostile proxies and subclasses can throw from otherwise standard error fields.
  }
  return new Error("Qi Manga request could not be completed safely. Please try again.");
};

const cookieDomain = (cookie: Cookie): string =>
  cookie.domain.trim().replace(/^\.+/, "").toLowerCase();

const currentTimestamp = (): number => {
  try {
    const value = Date.now();
    return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
};

const cookieTimestamp = (value: unknown): number | undefined => {
  try {
    if (!(value instanceof Date)) return undefined;
    const timestamp = Date.prototype.getTime.call(value) as number;
    return Number.isFinite(timestamp) ? timestamp : undefined;
  } catch {
    return undefined;
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

const qiMangaCookieSnapshot = (value: unknown): Cookie | undefined => {
  try {
    if (value === null || typeof value !== "object") return undefined;
    const cookie = value as Partial<Cookie>;
    const name = cookie.name;
    const cookieValue = cookie.value;
    const rawDomain = cookie.domain;
    const path = cookie.path;
    const created = cookie.created;
    const expires = cookie.expires;
    if (
      typeof rawDomain !== "string" ||
      rawDomain !== rawDomain.trim() ||
      rawDomain.trim().toLowerCase().startsWith("..") ||
      typeof name !== "string" ||
      name.length < 1 ||
      name.length > 256 ||
      !/^[!#$%&'*+\-.^_`|~\dA-Za-z]+$/.test(name) ||
      typeof cookieValue !== "string" ||
      cookieValue.length > 16 * 1_024 ||
      !isCookieOctetValue(cookieValue) ||
      (path !== undefined &&
        (typeof path !== "string" ||
          !path.startsWith("/") ||
          path.length > 2_048 ||
          containsControlCharacter(path) ||
          hasUnpairedSurrogate(path)))
    ) {
      return undefined;
    }

    const domain = rawDomain.trim().replace(/^\.+/, "").toLowerCase();
    if (domain !== "qimanga.com" && domain !== "api.qimanga.com") return undefined;
    const createdTimestamp = created === undefined ? undefined : cookieTimestamp(created);
    const expiresTimestamp = expires === undefined ? undefined : cookieTimestamp(expires);
    if (
      (created !== undefined && createdTimestamp === undefined) ||
      (expires !== undefined && expiresTimestamp === undefined)
    ) {
      return undefined;
    }

    return {
      name,
      value: cookieValue,
      domain: rawDomain,
      ...(path !== undefined && { path }),
      ...(createdTimestamp !== undefined && { created: new Date(createdTimestamp) }),
      ...(expiresTimestamp !== undefined && { expires: new Date(expiresTimestamp) }),
    };
  } catch {
    return undefined;
  }
};

export const isQiMangaCookie = (cookie: Cookie): boolean =>
  qiMangaCookieSnapshot(cookie) !== undefined;

const inspectedCookieSnapshots = (value: unknown, maximum = MAX_COOKIE_INPUTS): Cookie[] => {
  try {
    if (!Array.isArray(value)) return [];
    const length = value.length;
    if (!Number.isSafeInteger(length) || length < 0) return [];
    const snapshots: Cookie[] = [];
    for (let index = 0; index < length && index < maximum; index += 1) {
      let candidate: unknown;
      try {
        candidate = value[index];
      } catch {
        continue;
      }
      const snapshot = qiMangaCookieSnapshot(candidate);
      if (snapshot) snapshots.push(snapshot);
    }
    return snapshots;
  } catch {
    return [];
  }
};

const cookieSnapshotBytes = (cookie: Cookie): number =>
  utf8ByteLength(cookie.name) +
  utf8ByteLength(cookie.value) +
  utf8ByteLength(cookie.domain) +
  utf8ByteLength(cookie.path ?? "/") +
  192;

const boundedCookieSnapshots = (value: unknown): Cookie[] => {
  const bounded: Cookie[] = [];
  let bytes = 0;
  for (const cookie of inspectedCookieSnapshots(value)) {
    const nextBytes = cookieSnapshotBytes(cookie);
    if (bounded.length >= MAX_COOKIE_COUNT) break;
    if (bytes + nextBytes > MAX_COOKIE_BYTES) continue;
    bounded.push(cookie);
    bytes += nextBytes;
  }
  return bounded;
};

const CLOUDFLARE_COOKIE_NAMES = new Set([
  "cf_clearance",
  "__cf_bm",
  "__cflb",
  "__cfwaitingroom",
  "__cfseq",
  "_cfuvid",
  "cf_chl_rc_i",
  "cf_chl_rc_ni",
  "cf_chl_rc_m",
  "cf_ob_info",
  "cf_use_ob",
]);

export const isQiMangaCloudflareCookieName = (name: string): boolean => {
  try {
    return typeof name === "string" && CLOUDFLARE_COOKIE_NAMES.has(name);
  } catch {
    return false;
  }
};

export const isQiMangaAuthCookieName = (name: string): boolean =>
  !isQiMangaCloudflareCookieName(name);

export const qiMangaCloudflareCookieSnapshots = (value: unknown): Cookie[] =>
  inspectedCookieSnapshots(value).filter((cookie) => isQiMangaCloudflareCookieName(cookie.name));

export const persistQiMangaCookies = (
  store: QiMangaCookieStore,
  cookies: readonly Cookie[],
): void => {
  // WebView output is untrusted. Inspect a fixed ceiling even when a custom store
  // does not implement the aggregate bounds used by QiMangaCookieInterceptor.
  const now = currentTimestamp();
  const inspected = inspectedCookieSnapshots(cookies);
  const accepted = boundedCookieSnapshots(
    inspected.filter(
      (cookie) =>
        !cookie.expires || (cookieTimestamp(cookie.expires) ?? Number.NEGATIVE_INFINITY) > now,
    ),
  );
  for (const cookie of inspected) {
    if (!cookie.expires || (cookieTimestamp(cookie.expires) ?? Number.NEGATIVE_INFINITY) > now) {
      continue;
    }
    try {
      store.deleteCookie(cookie);
    } catch {
      // Keep malformed custom-store failures secret and continue with active cookies.
    }
  }
  let setCookies: unknown;
  try {
    setCookies = Reflect.get(store, "setCookies");
  } catch {
    return;
  }
  if (typeof setCookies === "function") {
    try {
      Reflect.apply(setCookies, store, [accepted]);
    } catch {
      // A custom runtime store may reject persistence. Verification then fails closed.
    }
    return;
  }

  for (const cookie of accepted) {
    try {
      store.setCookie(cookie);
    } catch {
      // Reject a malformed custom-store operation without retaining its error material.
    }
  }
};

const isUnexpiredCookie = (cookie: Cookie, now = currentTimestamp()): boolean =>
  !cookie.expires || (cookieTimestamp(cookie.expires) ?? Number.NEGATIVE_INFINITY) > now;

const inspectedStoreCookies = (store: QiMangaCookieStore): readonly Cookie[] => {
  try {
    return inspectedCookieSnapshots(store.cookies);
  } catch {
    return [];
  }
};

export const hasQiMangaAuthCookies = (store: QiMangaCookieStore): boolean =>
  inspectedStoreCookies(store).some(
    (cookie) =>
      isQiMangaCookie(cookie) && isQiMangaAuthCookieName(cookie.name) && isUnexpiredCookie(cookie),
  );

const cookiePathMatches = (requestPath: string, cookiePath: string): boolean =>
  cookiePath === "/" ||
  requestPath === cookiePath ||
  requestPath.startsWith(cookiePath.endsWith("/") ? cookiePath : `${cookiePath}/`);

/** Select only unexpired auth cookies whose domain and path apply to this API request. */
export const qiMangaAuthCookiesForUrl = (
  store: QiMangaCookieStore,
  requestUrl: string,
): Record<string, string> => {
  if (typeof requestUrl !== "string" || requestUrl.length > 2_048) return {};
  let url: PaperbackURL;
  try {
    url = new PaperbackURL(requestUrl);
  } catch {
    return {};
  }
  if (!isHttpsUrlForHosts(requestUrl, API_HOSTS)) return {};

  const hostname = url.hostname.toLowerCase();
  const requestPath = url.path.startsWith("/") ? url.path : `/${url.path}`;
  const candidates = inspectedStoreCookies(store)
    .filter((cookie) => {
      if (
        !isQiMangaCookie(cookie) ||
        !isQiMangaAuthCookieName(cookie.name) ||
        !isUnexpiredCookie(cookie)
      ) {
        return false;
      }
      const domain = cookieDomain(cookie);
      const path = cookie.path?.startsWith("/") ? cookie.path : "/";
      return (
        (hostname === domain || hostname.endsWith(`.${domain}`)) &&
        cookiePathMatches(requestPath, path)
      );
    })
    .sort((left, right) => {
      const pathDifference = (right.path?.length ?? 1) - (left.path?.length ?? 1);
      if (pathDifference !== 0) return pathDifference;
      const domainDifference = cookieDomain(right).length - cookieDomain(left).length;
      if (domainDifference !== 0) return domainDifference;
      return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
    });

  const result = new Map<string, string>();
  let resultBytes = 0;
  for (const cookie of candidates) {
    if (result.has(cookie.name)) continue;
    const nextBytes = utf8ByteLength(cookie.name) + utf8ByteLength(cookie.value) + 2;
    if (result.size >= MAX_COOKIE_COUNT) break;
    if (resultBytes + nextBytes > MAX_COOKIE_BYTES) continue;
    result.set(cookie.name, cookie.value);
    resultBytes += nextBytes;
  }
  return Object.fromEntries(result);
};

export const invalidateQiMangaAuth = (store: QiMangaCookieStore): void => {
  try {
    store.invalidateAuthCookies?.();
  } catch {
    // Continue with explicit deletion when a custom invalidation hook is unavailable.
  }
  for (const cookie of inspectedStoreCookies(store)) {
    if (!isQiMangaAuthCookieName(cookie.name)) continue;
    try {
      store.deleteCookie(cookie);
    } catch {
      // Never surface a custom store error that could contain cookie material.
    }
  }
};

export const replaceQiMangaCookies = (
  store: QiMangaCookieStore,
  cookies: readonly Cookie[],
): void => {
  invalidateQiMangaAuth(store);
  let acceptsAuthentication = true;
  try {
    store.acceptAuthCookies?.();
  } catch {
    acceptsAuthentication = false;
  }
  persistQiMangaCookies(
    store,
    acceptsAuthentication
      ? cookies
      : inspectedCookieSnapshots(cookies).filter((cookie) =>
          isQiMangaCloudflareCookieName(cookie.name),
        ),
  );
};

const cloneRequestHeaders = (value: unknown): Record<string, string> => {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const source = value as Record<string, unknown>;
    const headers: Record<string, string> = {};
    let inspected = 0;
    for (const name in source) {
      inspected += 1;
      if (inspected > MAX_HEADER_INPUTS) break;
      if (!Object.prototype.hasOwnProperty.call(source, name)) continue;
      const value = source[name];
      if (
        name.length < 1 ||
        name.length > 256 ||
        !/^[!#$%&'*+\-.^_`|~\dA-Za-z]+$/.test(name) ||
        name.toLowerCase() === QIMANGA_COOKIE_GENERATION_HEADER ||
        typeof value !== "string" ||
        value.length > 16 * 1_024 ||
        /[\r\n]/.test(value)
      ) {
        continue;
      }
      headers[name] = value;
    }
    return headers;
  } catch {
    // Drop malformed caller headers, including any forged generation marker.
    return {};
  }
};

const cloneRequestCookies = (value: unknown): Record<string, string> | undefined => {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const source = value as Record<string, unknown>;
    const cookies: Record<string, string> = {};
    let inspected = 0;
    let count = 0;
    let bytes = 0;
    for (const name in source) {
      inspected += 1;
      if (inspected > MAX_COOKIE_INPUTS) break;
      if (!Object.prototype.hasOwnProperty.call(source, name)) continue;
      const value = source[name];
      if (
        name.length < 1 ||
        name.length > 256 ||
        !/^[!#$%&'*+\-.^_`|~\dA-Za-z]+$/.test(name) ||
        typeof value !== "string" ||
        value.length > 16 * 1_024 ||
        !isCookieOctetValue(value)
      ) {
        continue;
      }
      const nextBytes = utf8ByteLength(name) + utf8ByteLength(value) + 2;
      if (count >= MAX_COOKIE_COUNT) break;
      if (bytes + nextBytes > MAX_COOKIE_BYTES) continue;
      cookies[name] = value;
      count += 1;
      bytes += nextBytes;
    }
    return count > 0 ? cookies : undefined;
  } catch {
    // Do not retain a malformed caller cookie map.
    return undefined;
  }
};

const cloneRequest = (request: Request, generation?: number): Request => {
  let url: string;
  let method: string;
  let body: Request["body"];
  let rawHeaders: unknown;
  let rawCookies: unknown;
  try {
    url = request.url;
    method = request.method;
    body = request.body;
    rawHeaders = request.headers;
    rawCookies = request.cookies;
  } catch {
    throw new Error("Qi Manga request could not be cloned safely.");
  }

  const headers = cloneRequestHeaders(rawHeaders);
  if (generation !== undefined) headers[QIMANGA_COOKIE_GENERATION_HEADER] = String(generation);
  const cookies = cloneRequestCookies(rawCookies);
  const cloned: Request = { url, method, headers };
  if (body !== undefined) cloned.body = body;
  if (cookies) cloned.cookies = cookies;
  return cloned;
};

/** Coalesce refreshes so parallel catalog/reader failures rotate the session only once. */
export const refreshQiMangaSession = (
  store: QiMangaCookieStore,
  timeoutMs: number = REFRESH_TIMEOUT_MS,
): Promise<number | undefined> => {
  const refreshGeneration = sensitiveGeneration(store);
  const active = refreshRequests.get(store);
  if (active && active.generation === refreshGeneration) return active.promise;

  const refresh = (async () => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      if (refreshGeneration === undefined) {
        throw new Error("Qi Manga authentication generation is invalid.");
      }
      const cookies = qiMangaAuthCookiesForUrl(store, REFRESH_URL);
      const request = cloneRequest(
        {
          url: REFRESH_URL,
          method: "POST",
          headers: { "cache-control": "no-store" },
          ...(Object.keys(cookies).length > 0 && { cookies }),
        },
        refreshGeneration,
      );
      const boundedTimeout =
        Number.isSafeInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : REFRESH_TIMEOUT_MS;
      const { response } = await Promise.race([
        scheduleBoundedResponse(request, REFRESH_RESPONSE_OPTIONS),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error("Qi Manga session refresh timed out.")),
            boundedTimeout,
          );
        }),
      ]);
      if (!generationMatches(store, refreshGeneration)) {
        throw new Error("Qi Manga authentication changed during session refresh.");
      }
      const status = responseStatus(response);
      if (!isSuccessfulHttpStatus(status)) {
        throw new SourceHttpError(REFRESH_RESPONSE_OPTIONS.sourceName, status);
      }
      // Response interceptors have already persisted any rotated cookies. Advance the
      // generation afterward so older in-flight responses cannot overwrite them.
      try {
        store.acceptAuthCookies?.();
      } catch {
        invalidateQiMangaAuth(store);
        throw new Error("Qi Manga authentication changed during session refresh.");
      }
      const completionGeneration = sensitiveGeneration(store);
      if (completionGeneration === undefined || completionGeneration === refreshGeneration) {
        invalidateQiMangaAuth(store);
        throw new Error("Qi Manga authentication changed during session refresh.");
      }
      return completionGeneration;
    } catch (error: unknown) {
      // A failed current-generation refresh leaves that session unverifiable. Never let
      // a stale refresh invalidate credentials installed by a newer login or logout.
      if (refreshGeneration === undefined || generationMatches(store, refreshGeneration)) {
        invalidateQiMangaAuth(store);
      }
      throw safeTransportError(error);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  })();

  refreshRequests.set(store, { generation: refreshGeneration, promise: refresh });
  const clearRefresh = (): void => {
    if (refreshRequests.get(store)?.promise === refresh) refreshRequests.delete(store);
  };
  void refresh.then(clearRefresh, clearRefresh);
  return refresh;
};

/** Retry an idempotent first-party API request once after the site's cookie refresh flow. */
export const fetchQiMangaTextWithSessionRefresh = async (
  store: QiMangaCookieStore,
  request: Request,
): Promise<string> => {
  const method = typeof request.method === "string" ? request.method : "";
  const canRefresh =
    (method === "GET" || method === "HEAD") &&
    request.url !== REFRESH_URL &&
    isApiRequestUrl(request.url) &&
    hasQiMangaAuthCookies(store);

  const initialGeneration = sensitiveGeneration(store);
  if (initialGeneration === undefined) {
    invalidateQiMangaAuth(store);
    throw safeTransportError(new Error("Qi Manga authentication generation is invalid."));
  }
  try {
    const body = await fetchText(cloneRequest(request, initialGeneration));
    if (!generationMatches(store, initialGeneration)) {
      throw new Error("Qi Manga authentication changed while this request was loading.");
    }
    return body;
  } catch (error: unknown) {
    if (!(canRefresh && error instanceof SourceHttpError && error.status === 401)) {
      throw safeTransportError(error);
    }
    if (!generationMatches(store, initialGeneration)) {
      throw safeTransportError(
        new Error("Qi Manga authentication changed while this request was loading."),
      );
    }
    if (!hasQiMangaAuthCookies(store)) {
      if (generationMatches(store, initialGeneration)) invalidateQiMangaAuth(store);
      throw safeTransportError(error);
    }
  }

  const refreshCompletionGeneration = await refreshQiMangaSession(store);
  if (!generationMatches(store, refreshCompletionGeneration)) {
    throw safeTransportError(
      new Error("Qi Manga authentication changed while this request was loading."),
    );
  }

  const retryGeneration = refreshCompletionGeneration;
  try {
    const body = await fetchText(cloneRequest(request, retryGeneration));
    if (!generationMatches(store, retryGeneration)) {
      throw new Error("Qi Manga authentication changed while this request was loading.");
    }
    return body;
  } catch (error: unknown) {
    if (
      error instanceof SourceHttpError &&
      error.status === 401 &&
      generationMatches(store, retryGeneration)
    ) {
      invalidateQiMangaAuth(store);
    }
    throw safeTransportError(error);
  }
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const isUnicodeNoncharacter = (codePoint: number): boolean =>
  (codePoint >= 0xfdd0 && codePoint <= 0xfdef) || (codePoint & 0xffff) >= 0xfffe;

const containsUnsafeControl = (value: string): boolean => {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (
      codePoint <= 0x08 ||
      codePoint === 0x0b ||
      codePoint === 0x0c ||
      (codePoint >= 0x0e && codePoint <= 0x1f) ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      isUnicodeNoncharacter(codePoint)
    ) {
      return true;
    }
  }
  return false;
};

const text = (value: unknown): string | undefined =>
  typeof value === "string" &&
  value.length <= 1_024 &&
  value.trim() &&
  !containsUnsafeControl(value) &&
  !hasUnpairedSurrogate(value)
    ? value.replace(/\s+/g, " ").trim()
    : undefined;

export const fetchQiMangaAccountStatus = async (
  store?: QiMangaCookieStore,
  isOperationCurrent?: () => boolean,
): Promise<QiMangaAccountStatus> => {
  const accountRequest = (generation: number | undefined): Request => {
    const cookies = store ? qiMangaAuthCookiesForUrl(store, ACCOUNT_URL) : {};
    return cloneRequest(
      {
        url: ACCOUNT_URL,
        method: "GET",
        headers: { "cache-control": "no-store" },
        ...(Object.keys(cookies).length > 0 && { cookies }),
      },
      generation,
    );
  };
  const requestAccount = async () => {
    const generation = store ? sensitiveGeneration(store) : undefined;
    if (store && generation === undefined) {
      throw new Error("Qi Manga authentication generation is invalid.");
    }
    const result = await scheduleBoundedResponse(
      accountRequest(generation),
      ACCOUNT_RESPONSE_OPTIONS,
    );
    return { ...result, generation, status: responseStatus(result.response) };
  };
  const operationIsCurrent = (): boolean => {
    try {
      return isOperationCurrent?.() ?? true;
    } catch {
      return false;
    }
  };
  const generationIsCurrent = (generation: number | undefined): boolean =>
    !store || generationMatches(store, generation);
  const isCurrent = (generation: number | undefined): boolean =>
    operationIsCurrent() && generationIsCurrent(generation);

  if (!operationIsCurrent()) return { authenticated: false };
  let result: Awaited<ReturnType<typeof requestAccount>>;
  try {
    result = await requestAccount();
    if (!operationIsCurrent()) return { authenticated: false };
    // Discard one response issued by an older login/logout generation and revalidate
    // the credentials that are current now. A second race remains fail-closed.
    if (!generationIsCurrent(result.generation)) result = await requestAccount();
    if (!isCurrent(result.generation)) return { authenticated: false };

    if (result.status === 401 && store && hasQiMangaAuthCookies(store)) {
      if (!operationIsCurrent()) return { authenticated: false };
      await refreshQiMangaSession(store);
      if (!operationIsCurrent()) return { authenticated: false };
      result = await requestAccount();
      if (!isCurrent(result.generation)) return { authenticated: false };
    }
  } catch {
    return { authenticated: false };
  }

  if (!isSuccessfulHttpStatus(result.status)) {
    if (store && isCurrent(result.generation) && (result.status === 401 || result.status === 403)) {
      invalidateQiMangaAuth(store);
    }
    return { authenticated: false };
  }

  try {
    assertResponseBodyWithinLimit(result.data, ACCOUNT_RESPONSE_OPTIONS);
    const user = asRecord(JSON.parse(decodeResponseBody(result.data)));
    const id = user?.id;
    const hasIdentifier =
      (typeof id === "number" && Number.isSafeInteger(id) && id > 0) ||
      (typeof id === "string" &&
        id.length <= 256 &&
        id === id.trim() &&
        id === id.normalize("NFC") &&
        Boolean(id) &&
        !/[\s\p{C}]/u.test(id) &&
        !containsUnsafeControl(id) &&
        !hasUnpairedSurrogate(id));
    if (!user || !hasIdentifier || !isCurrent(result.generation)) {
      return { authenticated: false };
    }
    const displayName = text(user.displayName) ?? text(user.username);
    if (!isCurrent(result.generation)) return { authenticated: false };
    return { authenticated: true, ...(displayName && { displayName }) };
  } catch {
    return { authenticated: false };
  }
};

export const signOutQiManga = async (store: QiMangaCookieStore): Promise<void> => {
  const signOutGeneration = sensitiveGeneration(store);
  const cookies =
    signOutGeneration === undefined ? {} : qiMangaAuthCookiesForUrl(store, SIGN_OUT_URL);
  const request = cloneRequest(
    {
      url: SIGN_OUT_URL,
      method: "POST",
      headers: { "cache-control": "no-store" },
      ...(Object.keys(cookies).length > 0 && { cookies }),
    },
    signOutGeneration,
  );
  // Start remote revocation while the captured session is still current. The
  // interceptor snapshots those exact scoped cookies synchronously, then local
  // invalidation blocks its eventual response from touching a replacement login.
  const remoteSignOut = scheduleBoundedResponse(request, SIGN_OUT_RESPONSE_OPTIONS)
    .then(({ response }) => {
      const status = responseStatus(response);
      if (!isSuccessfulHttpStatus(status)) {
        throw new SourceHttpError(SIGN_OUT_RESPONSE_OPTIONS.sourceName, status);
      }
    })
    .catch(() => undefined);
  invalidateQiMangaAuth(store);

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      remoteSignOut,
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, SIGN_OUT_TIMEOUT_MS);
      }),
    ]);
  } catch {
    // Local logout must still succeed while Qi Manga is unavailable.
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
};
