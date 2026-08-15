import { SourceRequestInterceptor } from "./http.js";
import type { NovelDashSite } from "./noveldash-models.js";
import { isHttpsUrlForHosts } from "./url.js";

const DOCUMENT_ACCEPT = "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8";

export class NovelDashInterceptor extends SourceRequestInterceptor {
  constructor(site: NovelDashSite) {
    const firstPartyHosts = new Set([site.host, `www.${site.host}`, site.mediaHost]);
    super(`${site.key}Interceptor`, {
      sourceName: site.name,
      resolutionUrl: `${site.domain}/`,
      referer: `${site.domain}/`,
      origin: site.domain,
      acceptLanguage: "en-US,en;q=0.9",
      documentAccept: DOCUMENT_ACCEPT,
      isFirstPartyUrl: (value) => isHttpsUrlForHosts(value, firstPartyHosts),
    });
  }
}
