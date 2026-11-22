import { SourceRequestInterceptor } from "../shared/http.js";
import { isHttpsUrlForHosts } from "../shared/url.js";
import { DOMAIN } from "./network.js";
import { SITE_HOSTS } from "./site.js";

export const PENGUIN_INTERCEPTOR_ID = "penguinSquadInterceptor";
const DOCUMENT_ACCEPT = "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8";

export class PenguinInterceptor extends SourceRequestInterceptor {
  constructor(id: string = PENGUIN_INTERCEPTOR_ID) {
    super(id, {
      sourceName: "Penguin Squad",
      resolutionUrl: `${DOMAIN}/`,
      referer: `${DOMAIN}/`,
      acceptLanguage: "en-US,en;q=0.9",
      documentAccept: DOCUMENT_ACCEPT,
      isFirstPartyUrl: (value) => isHttpsUrlForHosts(value, SITE_HOSTS),
    });
  }
}
