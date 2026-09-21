import { SourceRequestInterceptor } from "../shared/http.js";
import { isHttpsUrlForHosts } from "../shared/url.js";
import { ROOT_URL } from "./network.js";

export const ROKARI_INTERCEPTOR_ID = "rokariInterceptor";
const DOCUMENT_ACCEPT = "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8";
const FIRST_PARTY_HOSTS = new Set(["rokaricomics.com", "www.rokaricomics.com"]);

export class RokariInterceptor extends SourceRequestInterceptor {
  constructor(id: string = ROKARI_INTERCEPTOR_ID) {
    super(id, {
      sourceName: "Rokari",
      resolutionUrl: ROOT_URL,
      referer: ROOT_URL,
      acceptLanguage: "en-US,en;q=0.9",
      documentAccept: DOCUMENT_ACCEPT,
      isFirstPartyUrl: (value) => isHttpsUrlForHosts(value, FIRST_PARTY_HOSTS),
    });
  }
}
