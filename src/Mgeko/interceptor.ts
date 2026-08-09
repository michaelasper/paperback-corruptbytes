import { SourceRequestInterceptor } from "../shared/http.js";
import { isHttpsUrlForHosts } from "../shared/url.js";
import { ROOT_URL } from "./network.js";

export const MGEKO_INTERCEPTOR_ID = "mgekoInterceptor";
const DOCUMENT_ACCEPT = "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8";
const FIRST_PARTY_HOSTS = new Set(["mgeko.cc", "www.mgeko.cc"]);

export class MgekoInterceptor extends SourceRequestInterceptor {
  constructor(id: string = MGEKO_INTERCEPTOR_ID) {
    super(id, {
      sourceName: "Mgeko",
      resolutionUrl: ROOT_URL,
      referer: ROOT_URL,
      acceptLanguage: "en-US,en;q=0.9",
      documentAccept: DOCUMENT_ACCEPT,
      isFirstPartyUrl: (value) => isHttpsUrlForHosts(value, FIRST_PARTY_HOSTS),
    });
  }
}
