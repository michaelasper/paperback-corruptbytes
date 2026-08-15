import type { Cookie } from "@paperback/types";

import { SecureCookieInterceptor } from "./cookies.js";
import type { NovelDashSite } from "./noveldash-models.js";
import { fetchNovelDashJson } from "./noveldash-network.js";
import { isHttpsUrlForHosts } from "./url.js";

export interface NovelDashCookieStore {
  readonly cookies: Readonly<Cookie[]>;
  setCookie(cookie: Cookie): void;
  deleteCookie(cookie: Cookie): void;
  invalidateSensitiveCookies?(): void;
  acceptSensitiveCookies?(): void;
}

export interface NovelDashAccountStatus {
  authenticated: boolean;
  displayName?: string;
  email?: string;
}

const cookieDomain = (cookie: Cookie): string =>
  cookie.domain.trim().replace(/^\.+/, "").toLocaleLowerCase();

export const isNovelDashCookie = (site: NovelDashSite, cookie: Cookie): boolean => {
  const domain = cookieDomain(cookie);
  if (domain.startsWith("www.")) return false;
  return domain === site.host || domain.endsWith(`.${site.host}`);
};

export const isNovelDashAuthCookieName = (cookieName: string): boolean => {
  const name = cookieName.toLocaleLowerCase().replace(/^__(?:secure|host)-/, "");
  return /^(?:authjs|next-auth)[._-]/.test(name) || /(?:^|[._-])session-token$/.test(name);
};

export const persistNovelDashCookies = (
  site: NovelDashSite,
  store: NovelDashCookieStore,
  cookies: readonly Cookie[],
): void => {
  const now = Date.now();
  for (const cookie of cookies) {
    if (!isNovelDashCookie(site, cookie)) continue;
    if (cookie.expires && cookie.expires.getTime() <= now) store.deleteCookie(cookie);
    else store.setCookie(cookie);
  }
};

export const clearNovelDashAuthCookies = (store: NovelDashCookieStore): void => {
  store.invalidateSensitiveCookies?.();
  for (const cookie of store.cookies) {
    if (isNovelDashAuthCookieName(cookie.name)) store.deleteCookie(cookie);
  }
};

export const replaceNovelDashCookies = (
  site: NovelDashSite,
  store: NovelDashCookieStore,
  cookies: readonly Cookie[],
): void => {
  clearNovelDashAuthCookies(store);
  store.acceptSensitiveCookies?.();
  persistNovelDashCookies(site, store, cookies);
};

export class NovelDashCookieInterceptor extends SecureCookieInterceptor {
  constructor(readonly site: NovelDashSite) {
    const cookieHosts = new Set([site.host, `www.${site.host}`]);
    super({
      stateKey: `${site.key}.secure_cookies`,
      generationHeader: `x-paperback-${site.key.replace(/[^a-z\d-]/gi, "-")}-cookie-generation`,
      isTrustedRequestUrl: (value) => isHttpsUrlForHosts(value, cookieHosts),
      isAcceptedCookie: (cookie) => isNovelDashCookie(site, cookie),
      isSensitiveCookieName: isNovelDashAuthCookieName,
    });
  }
}

export const fetchNovelDashAccountStatus = async (
  site: NovelDashSite,
  store?: NovelDashCookieStore,
): Promise<NovelDashAccountStatus> => {
  let value: unknown;
  try {
    value = await fetchNovelDashJson<unknown>(
      site,
      { url: `${site.domain}/api/auth/session`, method: "GET" },
      256 * 1_024,
    );
  } catch {
    return { authenticated: false };
  }
  const session =
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  const user =
    session?.user !== null && typeof session?.user === "object" && !Array.isArray(session.user)
      ? (session.user as Record<string, unknown>)
      : undefined;
  if (!session || !user) {
    if (store) clearNovelDashAuthCookies(store);
    return { authenticated: false };
  }
  const displayName =
    typeof user.name === "string" && user.name.trim() ? user.name.trim() : undefined;
  const email = typeof user.email === "string" && user.email.trim() ? user.email.trim() : undefined;
  const identifier = user.id;
  const authenticated =
    (typeof identifier === "string" && identifier.trim().length > 0) ||
    (typeof identifier === "number" && Number.isFinite(identifier)) ||
    Boolean(displayName || email);
  if (!authenticated) {
    if (store) clearNovelDashAuthCookies(store);
    return { authenticated: false };
  }
  return {
    authenticated: true,
    ...(displayName && { displayName }),
    ...(email && { email }),
  };
};
