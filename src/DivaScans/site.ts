import type { NovelDashSite } from "../shared/noveldash-models.js";

export const DIVA_SCANS_SITE = {
  key: "diva_scans",
  name: "Diva Scans",
  domain: "https://divascans.org",
  host: "divascans.org",
  mediaHost: "media.divascans.org",
} as const satisfies NovelDashSite;
