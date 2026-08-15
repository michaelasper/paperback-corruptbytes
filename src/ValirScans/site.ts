import type { NovelDashSite } from "../shared/noveldash-models.js";

export const VALIR_SCANS_SITE = {
  key: "valir_scans",
  name: "Valir Scans",
  domain: "https://valirscans.org",
  host: "valirscans.org",
  mediaHost: "media.valirscans.org",
} as const satisfies NovelDashSite;
