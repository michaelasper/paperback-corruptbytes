import { SourceRequestInterceptor } from "../shared/http.js";
import { isHttpsUrlForHosts } from "../shared/url.js";
import { DOMAIN } from "./network.js";

export const THUNDER_INTERCEPTOR_ID = "thunderScansInterceptor";
const ROOT_URL = `${DOMAIN}/`;
const TRUSTED_HOSTS = new Set(["en-thunderscans.com"]);
const DOCUMENT_ACCEPT = "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8";

export class ThunderInterceptor extends SourceRequestInterceptor {
  constructor(id: string = THUNDER_INTERCEPTOR_ID) {
    super(id, {
      sourceName: "Thunder Scans",
      resolutionUrl: ROOT_URL,
      referer: ROOT_URL,
      origin: DOMAIN,
      acceptLanguage: "en-US,en;q=0.9",
      documentAccept: DOCUMENT_ACCEPT,
      isFirstPartyUrl: (value) => isHttpsUrlForHosts(value, TRUSTED_HOSTS),
    });
  }
}
