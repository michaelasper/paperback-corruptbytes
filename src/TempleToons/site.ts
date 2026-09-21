export const TEMPLE_SITE = {
  key: "temple_toons",
  name: "Temple Scan",
  domain: "https://templetoons.com",
  host: "templetoons.com",
  mediaHost: "media.templetoons.com",
  legacyDomain: "https://templescan.net",
} as const;

export type TempleSite = typeof TEMPLE_SITE;
