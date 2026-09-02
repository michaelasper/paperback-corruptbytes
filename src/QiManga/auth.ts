import type { Cookie, Request } from "@paperback/types";

import {
  assertResponseBodyWithinLimit,
  decodeResponseBody,
  scheduleBoundedResponse,
  scheduleRawResponse,
  SourceHttpError,
} from "../shared/http.js";
import { isHttpsUrlForHosts } from "../shared/url.js";
import { API_BASE_URL, fetchText, isApiRequestUrl } from "./network.js";

export const ACCOUNT_URL = `${API_BASE_URL}/users/me`;
export const REFRESH_URL = `${API_BASE_URL}/auth/refresh`;
export const SIGN_OUT_URL = `${API_BASE_URL}/auth/logout`;

export interface QiMangaCookieStore {
  readonly cookies: Readonly<Cookie[]>;
  /** Monotonically changes whenever the installed authentication session changes. */
  readonly authCookieGeneration?: number;
  setCookie(cookie: Cookie): void;
  setCookies?(cookies: readonly Cookie[]): void;
  deleteCookie(cookie: Cookie): void;
  invalidateAuthCookies?(): void;
  acceptAuthCookies?(): void;
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
    isHttpsUrlForHosts(requestUrl, API_HOSTS) && isHttpsUrlForHosts(responseUrl, API_HOSTS),
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
export const MAX_QIMANGA_COOKIE_CANDIDATES = 128;
const refreshRequests = new WeakMap<QiMangaCookieStore, Map<number | undefined, Promise<void>>>();

const cookieDomain = (cookie: Cookie): string => {
  if (typeof cookie.domain !== "string" || cookie.domain !== cookie.domain.trim()) return "";
  return cookie.domain.replace(/^\.+/, "").toLowerCase();
};

const isValidCookieDate = (value: Date | undefined): boolean =>
  value === undefined || (value instanceof Date && Number.isFinite(value.getTime()));

export const isQiMangaCookie = (cookie: Cookie): boolean => {
  const domain = cookieDomain(cookie);
  return (
    (domain === "qimanga.com" || domain === "api.qimanga.com") &&
    typeof cookie.name === "string" &&
    cookie.name.length >= 1 &&
    cookie.name.length <= 256 &&
    /^[!#$%&'*+\-.^_`|~\dA-Za-z]+$/.test(cookie.name) &&
    typeof cookie.value === "string" &&
    cookie.value.length <= 16 * 1_024 &&
    !/[\0\r\n]/.test(cookie.value) &&
    (cookie.path === undefined ||
      (typeof cookie.path === "string" &&
        cookie.path.startsWith("/") &&
        cookie.path.length <= 2_048)) &&
    isValidCookieDate(cookie.created) &&
    isValidCookieDate(cookie.expires)
  );
};

export const isQiMangaCloudflareCookieName = (name: string): boolean =>
  /^(?:cf_clearance|__cf_bm|__cflb|__cfwaitingroom|_cfuvid|cf_chl_[a-z\d_]+|cf_ob_info|cf_use_ob)$/i.test(
    name,
  );

export const isQiMangaAuthCookieName = (name: string): boolean =>
  !isQiMangaCloudflareCookieName(name);

export const persistQiMangaCookies = (
  store: QiMangaCookieStore,
  cookies: readonly Cookie[],
): void => {
  const candidates: Cookie[] = [];
  const maximum = Math.min(cookies.length, MAX_QIMANGA_COOKIE_CANDIDATES);
  for (let index = 0; index < maximum; index += 1) {
    const cookie = cookies[index];
    if (cookie && isQiMangaCookie(cookie)) candidates.push(cookie);
  }
  if (store.setCookies) {
    store.setCookies(candidates);
    return;
  }

  const now = Date.now();
  for (const cookie of candidates) {
    if (cookie.expires && cookie.expires.getTime() <= now) store.deleteCookie(cookie);
    else store.setCookie(cookie);
  }
};

export const hasQiMangaAuthCookies = (store: QiMangaCookieStore): boolean =>
  store.cookies.some((cookie) => isQiMangaCookie(cookie) && isQiMangaAuthCookieName(cookie.name));

export const invalidateQiMangaAuth = (store: QiMangaCookieStore): void => {
  store.invalidateAuthCookies?.();
  for (const cookie of store.cookies) {
    if (isQiMangaCookie(cookie) && isQiMangaAuthCookieName(cookie.name)) {
      store.deleteCookie(cookie);
    }
  }
};

export const replaceQiMangaCookies = (
  store: QiMangaCookieStore,
  cookies: readonly Cookie[],
): void => {
  invalidateQiMangaAuth(store);
  store.acceptAuthCookies?.();
  persistQiMangaCookies(store, cookies);
};

const cloneRequest = (request: Request): Request => ({
  ...request,
  ...(request.headers && { headers: { ...request.headers } }),
  ...(request.cookies && { cookies: { ...request.cookies } }),
});

const isRejectedSession = (error: unknown): error is SourceHttpError =>
  error instanceof SourceHttpError && (error.status === 401 || error.status === 403);

const authCookieGeneration = (store: QiMangaCookieStore): number | undefined =>
  store.authCookieGeneration;

const generationMatches = (store: QiMangaCookieStore, expected: number | undefined): boolean =>
  expected === undefined || store.authCookieGeneration === expected;

const invalidateIfCurrent = (store: QiMangaCookieStore, expected: number | undefined): void => {
  if (generationMatches(store, expected)) invalidateQiMangaAuth(store);
};

/** Coalesce refreshes for the same installed session, without joining stale-session work. */
export const refreshQiMangaSession = (store: QiMangaCookieStore): Promise<void> => {
  const generation = authCookieGeneration(store);
  let activeByGeneration = refreshRequests.get(store);
  const active = activeByGeneration?.get(generation);
  if (active) return active;
  if (!activeByGeneration) {
    activeByGeneration = new Map();
    refreshRequests.set(store, activeByGeneration);
  }

  const refresh = (async () => {
    const { response, data } = await scheduleRawResponse(
      {
        url: REFRESH_URL,
        method: "POST",
        headers: { "cache-control": "no-store" },
      },
      REFRESH_RESPONSE_OPTIONS,
    );
    if (response.status < 200 || response.status >= 300) {
      const error = new SourceHttpError(REFRESH_RESPONSE_OPTIONS.sourceName, response.status);
      if (isRejectedSession(error)) invalidateIfCurrent(store, generation);
      throw error;
    }
    assertResponseBodyWithinLimit(data, REFRESH_RESPONSE_OPTIONS);
    // Cookie response interception has already installed the rotated session. Advancing
    // the generation lets delayed 401 responses reuse it instead of refreshing again.
    if (generationMatches(store, generation)) store.acceptAuthCookies?.();
  })();

  activeByGeneration.set(generation, refresh);
  const clearRefresh = (): void => {
    const requests = refreshRequests.get(store);
    if (requests?.get(generation) === refresh) requests.delete(generation);
    if (requests?.size === 0) refreshRequests.delete(store);
  };
  void refresh.then(clearRefresh, clearRefresh);
  return refresh;
};

/** Retry an idempotent first-party API request once after the site's cookie refresh flow. */
export const fetchQiMangaTextWithSessionRefresh = async (
  store: QiMangaCookieStore,
  request: Request,
): Promise<string> => {
  const method = request.method.trim().toUpperCase();
  const initialGeneration = authCookieGeneration(store);
  const canRefresh =
    (method === "GET" || method === "HEAD") &&
    request.url !== REFRESH_URL &&
    isApiRequestUrl(request.url) &&
    hasQiMangaAuthCookies(store);

  let rejectedRequest: SourceHttpError;
  try {
    return await fetchText(cloneRequest(request));
  } catch (error: unknown) {
    if (!(canRefresh && error instanceof SourceHttpError && error.status === 401)) throw error;
    rejectedRequest = error;
  }

  if (generationMatches(store, initialGeneration)) {
    await refreshQiMangaSession(store);
  }
  if (!hasQiMangaAuthCookies(store)) throw rejectedRequest;

  const retryGeneration = authCookieGeneration(store);
  try {
    return await fetchText(cloneRequest(request));
  } catch (error: unknown) {
    if (error instanceof SourceHttpError && error.status === 401) {
      invalidateIfCurrent(store, retryGeneration);
    }
    throw error;
  }
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const containsUnsafeControl = (value: string): boolean => {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (
      codePoint <= 0x08 ||
      codePoint === 0x0b ||
      codePoint === 0x0c ||
      (codePoint >= 0x0e && codePoint <= 0x1f) ||
      (codePoint >= 0x7f && codePoint <= 0x9f)
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
  !containsUnsafeControl(value)
    ? value.replace(/\s+/g, " ").trim()
    : undefined;

export const fetchQiMangaAccountStatus = async (
  store?: QiMangaCookieStore,
): Promise<QiMangaAccountStatus> => {
  const request: Request = {
    url: ACCOUNT_URL,
    method: "GET",
    headers: { "cache-control": "no-store" },
  };
  let response;
  let data: ArrayBuffer;
  let responseGeneration = store && authCookieGeneration(store);
  try {
    ({ response, data } = await scheduleRawResponse(
      cloneRequest(request),
      ACCOUNT_RESPONSE_OPTIONS,
    ));
    if (response.status === 401 && store && hasQiMangaAuthCookies(store)) {
      if (generationMatches(store, responseGeneration)) await refreshQiMangaSession(store);
      if (hasQiMangaAuthCookies(store)) {
        responseGeneration = authCookieGeneration(store);
        ({ response, data } = await scheduleRawResponse(
          cloneRequest(request),
          ACCOUNT_RESPONSE_OPTIONS,
        ));
      }
    }
  } catch {
    return { authenticated: false };
  }

  if (response.status < 200 || response.status >= 300) {
    if (store && (response.status === 401 || response.status === 403)) {
      invalidateIfCurrent(store, responseGeneration);
    }
    return { authenticated: false };
  }

  try {
    assertResponseBodyWithinLimit(data, ACCOUNT_RESPONSE_OPTIONS);
    const user = asRecord(JSON.parse(decodeResponseBody(data)));
    const id = user?.id;
    const hasIdentifier =
      (typeof id === "number" && Number.isSafeInteger(id) && id >= 0) ||
      (typeof id === "string" && id.length <= 256 && Boolean(id.trim()));
    if (!user || !hasIdentifier) return { authenticated: false };
    const displayName = text(user.displayName) ?? text(user.username);
    return { authenticated: true, ...(displayName && { displayName }) };
  } catch {
    return { authenticated: false };
  }
};

export const signOutQiManga = async (store: QiMangaCookieStore): Promise<void> => {
  const cookies = Object.fromEntries(
    store.cookies
      .filter((cookie) => isQiMangaCookie(cookie) && isQiMangaAuthCookieName(cookie.name))
      .map((cookie): [string, string] => [cookie.name, cookie.value]),
  );
  invalidateQiMangaAuth(store);

  const request: Request = {
    url: SIGN_OUT_URL,
    method: "POST",
    headers: { "cache-control": "no-store" },
    ...(Object.keys(cookies).length > 0 && { cookies }),
  };
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve()
        .then(() => scheduleBoundedResponse(request, SIGN_OUT_RESPONSE_OPTIONS))
        .then(() => undefined)
        .catch(() => undefined),
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
