export const PENGUIN_SITE = {
  name: "Penguin Squad",
  domain: "https://penguin-squad.com",
  host: "penguin-squad.com",
} as const;

export const SITE_HOSTS: ReadonlySet<string> = new Set([
  "penguin-squad.com",
  "www.penguin-squad.com",
]);

/** Observed cover CDN tenant. Other Supabase tenants are never trusted. */
export const COVER_HOSTS: ReadonlySet<string> = new Set(["qdqgxwrdzpxpkvamufqp.supabase.co"]);

export const SITE_ICON_URL = `${PENGUIN_SITE.domain}/web-app-manifest-512x512.png`;

export const MAX_CATALOG_PAGES = 500;
export const MAX_SEARCH_TERM_LENGTH = 100;
