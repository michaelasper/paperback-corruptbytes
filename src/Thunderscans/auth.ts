import type { Cookie } from "@paperback/types";
import { load } from "cheerio";

import { PROFILE_URL } from "./network.js";

export interface ThunderCookieStore {
  readonly cookies: Readonly<Cookie[]>;
  setCookie(cookie: Cookie): void;
  deleteCookie(cookie: Cookie): void;
  invalidateAuthCookies?(): void;
  acceptAuthCookies?(): void;
}

export interface AccountStatus {
  authenticated: boolean;
  displayName?: string;
}

const cookieDomain = (cookie: Cookie): string =>
  cookie.domain.trim().replace(/^\.+/, "").toLowerCase();

export const isThunderCookie = (cookie: Cookie): boolean =>
  cookieDomain(cookie) === "en-thunderscans.com";

export const isCloudflareCookieName = (name: string): boolean =>
  /^(?:_cf|cf_|__cf|cf-chl|cf_chl)/i.test(name);

export const isThunderAuthCookieName = (name: string): boolean => !isCloudflareCookieName(name);

export const isThunderScopedCookieName = (name: string): boolean =>
  /^(?:PHPSESSID|wordpress_|wp-settings|wp_woocommerce|woocommerce_|_cf|cf_|__cf|cf-chl|cf_chl)/i.test(
    name,
  );

export const persistThunderCookies = (store: ThunderCookieStore, cookies: Cookie[]): void => {
  const now = Date.now();
  for (const cookie of cookies) {
    if (!isThunderCookie(cookie)) continue;
    if (cookie.expires && cookie.expires.getTime() <= now) {
      store.deleteCookie(cookie);
      continue;
    }
    store.setCookie(cookie);
  }
};

export const clearThunderSession = (store: ThunderCookieStore): void => {
  for (const cookie of store.cookies) {
    if (isThunderCookie(cookie) && isThunderAuthCookieName(cookie.name)) {
      store.deleteCookie(cookie);
    }
  }
};

export const invalidateThunderAuth = (store: ThunderCookieStore): void => {
  store.invalidateAuthCookies?.();
  clearThunderSession(store);
};

export const replaceThunderCookies = (store: ThunderCookieStore, cookies: Cookie[]): void => {
  invalidateThunderAuth(store);
  store.acceptAuthCookies?.();
  persistThunderCookies(store, cookies);
};

const profileDisplayName = (html: string): string | undefined => {
  const $ = load(html);
  const value = $(".profile-name, .user-display-name, [data-profile-name]").first().text();
  return value.replace(/\s+/g, " ").trim() || undefined;
};

const isProfileUrl = (value: string): boolean =>
  /^https:\/\/en-thunderscans\.com\/profile\/?(?:[?#].*)?$/i.test(value);

export const fetchAccountStatus = async (store?: ThunderCookieStore): Promise<AccountStatus> => {
  try {
    const [response, buffer] = await Application.scheduleRequest({
      url: PROFILE_URL,
      method: "GET",
      headers: { "cache-control": "no-store" },
    });
    if (response.status < 200 || response.status >= 300 || !isProfileUrl(response.url)) {
      if (
        store &&
        (response.status === 401 || response.status === 403 || /\/login\/?/i.test(response.url))
      ) {
        invalidateThunderAuth(store);
      }
      return { authenticated: false };
    }

    const html = Application.arrayBufferToUTF8String(buffer);
    const displayName = profileDisplayName(html);
    return { authenticated: true, ...(displayName && { displayName }) };
  } catch {
    return { authenticated: false };
  }
};
