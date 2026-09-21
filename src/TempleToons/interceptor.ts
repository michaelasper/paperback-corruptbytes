import { SourceRequestInterceptor } from "../shared/http.js";
import { isHttpsUrlForHosts } from "../shared/url.js";
import { ROOT_URL } from "./network.js";

export const TEMPLE_INTERCEPTOR_ID = "templeInterceptor";
const DOCUMENT_ACCEPT = "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8";
const FIRST_PARTY_HOSTS = new Set(["templetoons.com", "www.templetoons.com"]);

export class TempleInterceptor extends SourceRequestInterceptor {
  constructor(id: string = TEMPLE_INTERCEPTOR_ID) {
    super(id, {
      sourceName: "Temple",
      resolutionUrl: ROOT_URL,
      referer: ROOT_URL,
      acceptLanguage: "en-US,en;q=0.9",
      documentAccept: DOCUMENT_ACCEPT,
      isFirstPartyUrl: (value) => isHttpsUrlForHosts(value, FIRST_PARTY_HOSTS),
    });
  }
}
