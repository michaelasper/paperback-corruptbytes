import type { Cookie, Request } from "@paperback/types";

import {
  assertResponseBodyWithinLimit,
  decodeResponseBody,
  scheduleBoundedResponse,
  scheduleRawResponse,
} from "../shared/http.js";
import { isHttpsUrlForHosts } from "../shared/url.js";
import { API_BASE_URL } from "./network.js";

export const ACCOUNT_URL = `${API_BASE_URL}/users/me`;
export const SIGN_OUT_URL = `${API_BASE_URL}/auth/logout`;

export interface QiMangaCookieStore {
  readonly cookies: Readonly<Cookie[]>;
  setCookie(cookie: Cookie): void;
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
const SIGN_OUT_RESPONSE_OPTIONS = {
  sourceName: "Qi Manga logout",
  maxBodyBytes: 256 * 1_024,
  isResponseUrlAllowed: ACCOUNT_RESPONSE_OPTIONS.isResponseUrlAllowed,
} as const;
const SIGN_OUT_TIMEOUT_MS = 5_000;

const cookieDomain = (cookie: Cookie): string =>
  typeof cookie.domain === "string" ? cookie.domain.trim().replace(/^\.+/, "").toLowerCase() : "";

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
  const now = Date.now();
  for (const cookie of cookies) {
    if (!isQiMangaCookie(cookie)) continue;
    if (cookie.expires && cookie.expires.getTime() <= now) {
      store.deleteCookie(cookie);
      continue;
    }
    store.setCookie(cookie);
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
  let response;
  let data: ArrayBuffer;
  try {
    ({ response, data } = await scheduleRawResponse(
      { url: ACCOUNT_URL, method: "GET", headers: { "cache-control": "no-store" } },
      ACCOUNT_RESPONSE_OPTIONS,
    ));
  } catch {
    return { authenticated: false };
  }

  if (response.status < 200 || response.status >= 300) {
    if (store && (response.status === 401 || response.status === 403)) {
      invalidateQiMangaAuth(store);
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
