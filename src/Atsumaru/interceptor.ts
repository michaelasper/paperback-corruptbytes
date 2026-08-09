import { SourceRequestInterceptor } from "../shared/http.js";
import { isHttpsUrlForHosts } from "../shared/url.js";
import { ROOT_URL } from "./network.js";

export const ATSUMARU_INTERCEPTOR_ID = "atsumaruInterceptor";
const FIRST_PARTY_HOSTS = new Set(["atsu.moe", "www.atsu.moe"]);
const DOCUMENT_ACCEPT = "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8";

/**
 * Atsumaru's API and site need browser-like first-party headers. The CDN is a
 * separate origin and deliberately receives only Paperback's neutral user
 * agent (never site referers, origin, or challenge cookies).
 */
export class AtsumaruInterceptor extends SourceRequestInterceptor {
  constructor(id: string = ATSUMARU_INTERCEPTOR_ID) {
    super(id, {
      sourceName: "Atsumaru",
      resolutionUrl: ROOT_URL,
      referer: ROOT_URL,
      origin: "https://atsu.moe",
      acceptLanguage: "en-US,en;q=0.9",
      documentAccept: DOCUMENT_ACCEPT,
      isFirstPartyUrl: (value) => isHttpsUrlForHosts(value, FIRST_PARTY_HOSTS),
    });
  }
}
