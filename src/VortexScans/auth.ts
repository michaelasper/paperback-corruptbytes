import type { Cookie, Request } from "@paperback/types";

import {
  assertResponseBodyWithinLimit,
  decodeResponseBody,
  scheduleBoundedResponse,
  scheduleRawResponse,
} from "../shared/http.js";
import { isHttpsUrlForHosts } from "../shared/url.js";
import { buildApiUrl } from "./network.js";

export const SIGN_OUT_URL = buildApiUrl("auth/sign-out");
export const ACCOUNT_URL = buildApiUrl("me");

export interface CookieStore {
  readonly cookies: Readonly<Cookie[]>;
  setCookie(cookie: Cookie): void;
  deleteCookie(cookie: Cookie): void;
  invalidateAuthCookies?(): void;
  acceptAuthCookies?(): void;
}

export interface AccountStatus {
  authenticated: boolean;
  displayName?: string;
  email?: string;
}

interface AccountResponse {
  user?: {
    id?: unknown;
    name?: unknown;
    email?: unknown;
  } | null;
  session?: unknown;
  hasSessionCookie?: boolean;
}

const SIGN_OUT_TIMEOUT_MS = 5_000;

const sanitizeDomain = (domain: string): string => domain.trim().replace(/^\.+/, "").toLowerCase();

export const isVortexCookie = (cookie: Cookie): boolean => {
  const domain = sanitizeDomain(cookie.domain);
  // Paperback's cookie jar strips a leading `www.` while matching domains,
  // which would incorrectly broaden a www-only cookie to every subdomain.
  if (domain.startsWith("www.")) return false;
  return domain === "vortexscans.org" || domain.endsWith(".vortexscans.org");
};

export const isVortexAuthCookieName = (cookieName: string): boolean => {
  const name = cookieName.toLowerCase().replace(/^__(?:secure|host)-/, "");
  return /^(?:vthemeauth|better-auth)[._]/.test(name);
};

export const isVortexAuthCookie = (cookie: Cookie): boolean =>
  isVortexCookie(cookie) && isVortexAuthCookieName(cookie.name);

export const persistVortexCookies = (store: CookieStore, cookies: Cookie[]): void => {
  const now = Date.now();
  for (const cookie of cookies) {
    if (!isVortexCookie(cookie)) continue;
    if (cookie.expires && cookie.expires.getTime() <= now) {
      store.deleteCookie(cookie);
      continue;
    }
    store.setCookie(cookie);
  }
};

export const clearVortexCookies = (store: CookieStore): void => {
  for (const cookie of store.cookies) {
    if (isVortexAuthCookie(cookie)) store.deleteCookie(cookie);
  }
};

export const invalidateVortexAuth = (store: CookieStore): void => {
  store.invalidateAuthCookies?.();
  clearVortexCookies(store);
};

export const replaceVortexCookies = (store: CookieStore, cookies: Cookie[]): void => {
  invalidateVortexAuth(store);
  store.acceptAuthCookies?.();
  persistVortexCookies(store, cookies);
};

const ACCOUNT_HOSTS = new Set(["api.vortexscans.org"]);
const ACCOUNT_RESPONSE_OPTIONS = {
  sourceName: "Vortex Scans account",
  maxBodyBytes: 256 * 1_024,
  isResponseUrlAllowed: (requestUrl: string, responseUrl: string) =>
    isHttpsUrlForHosts(requestUrl, ACCOUNT_HOSTS) && isHttpsUrlForHosts(responseUrl, ACCOUNT_HOSTS),
} as const;
const SIGN_OUT_RESPONSE_OPTIONS = {
  sourceName: "Vortex Scans logout",
  maxBodyBytes: 256 * 1_024,
  isResponseUrlAllowed: (requestUrl: string, responseUrl: string) =>
    isHttpsUrlForHosts(requestUrl, ACCOUNT_HOSTS) && isHttpsUrlForHosts(responseUrl, ACCOUNT_HOSTS),
} as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const hasIdentifier = (value: unknown): boolean => {
  if (!isRecord(value)) return false;
  const id = value.id;
  return (
    (typeof id === "string" && id.trim().length > 0) ||
    (typeof id === "number" && Number.isFinite(id))
  );
};

export const fetchAccountStatus = async (store?: CookieStore): Promise<AccountStatus> => {
  let response;
  let data: ArrayBuffer;
  try {
    ({ response, data } = await scheduleRawResponse(
      { url: ACCOUNT_URL, method: "GET" },
      ACCOUNT_RESPONSE_OPTIONS,
    ));
  } catch {
    return { authenticated: false };
  }

  if (response.status < 200 || response.status >= 300) {
    if (store && (response.status === 401 || response.status === 403)) {
      invalidateVortexAuth(store);
    }
    return { authenticated: false };
  }

  try {
    assertResponseBodyWithinLimit(data, ACCOUNT_RESPONSE_OPTIONS);
    const parsed = JSON.parse(decodeResponseBody(data)) as AccountResponse;
    const hasUser = hasIdentifier(parsed.user);
    const hasSession = parsed.hasSessionCookie === true && hasIdentifier(parsed.session);
    if (!hasUser && !hasSession) {
      const isDefinitivelyLoggedOut =
        parsed.user === null || parsed.session === null || parsed.hasSessionCookie === false;
      if (store && isDefinitivelyLoggedOut) invalidateVortexAuth(store);
      return { authenticated: false };
    }

    const displayName =
      typeof parsed.user?.name === "string" && parsed.user.name.trim()
        ? parsed.user.name.trim()
        : undefined;
    const email =
      typeof parsed.user?.email === "string" && parsed.user.email.trim()
        ? parsed.user.email.trim()
        : undefined;

    return {
      authenticated: true,
      ...(displayName && { displayName }),
      ...(email && { email }),
    };
  } catch {
    return { authenticated: false };
  }
};

export const signOut = async (store: CookieStore): Promise<void> => {
  const cookies = Object.fromEntries(
    store.cookies
      .filter(isVortexAuthCookie)
      .map((cookie): [string, string] => [cookie.name, cookie.value]),
  );
  invalidateVortexAuth(store);

  const request: Request = {
    url: SIGN_OUT_URL,
    method: "POST",
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
    // A local logout must still succeed when Vortex is offline.
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
};
