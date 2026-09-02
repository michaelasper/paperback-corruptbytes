import { URL as PaperbackURL, type Request, type Response } from "@paperback/types";

import { SourceRequestInterceptor } from "../shared/http.js";
import { isHttpsUrlForHosts } from "../shared/url.js";
import { DOMAIN } from "./network.js";

export const QIMANGA_INTERCEPTOR_ID = "qiMangaInterceptor";
const FIRST_PARTY_HOSTS = new Set(["qimanga.com", "www.qimanga.com", "api.qimanga.com"]);
const DOCUMENT_ACCEPT = "application/json,text/plain;q=0.9,text/html;q=0.8,*/*;q=0.7";

const isPublicFallbackAssetUrl = (value: string): boolean => {
  try {
    const url = new PaperbackURL(value);
    return url.hostname.toLowerCase() === "qimanga.com" && url.path === "/qiscans.ico";
  } catch {
    return false;
  }
};

const isFirstPartyUrl = (value: string): boolean =>
  isHttpsUrlForHosts(value, FIRST_PARTY_HOSTS) && !isPublicFallbackAssetUrl(value);

const hostname = (value: string): string | undefined => {
  try {
    return new PaperbackURL(value).hostname.toLowerCase();
  } catch {
    return undefined;
  }
};

export class QiMangaInterceptor extends SourceRequestInterceptor {
  constructor(id: string = QIMANGA_INTERCEPTOR_ID) {
    super(id, {
      sourceName: "Qi Manga",
      resolutionUrl: DOMAIN,
      referer: `${DOMAIN}/`,
      origin: DOMAIN,
      acceptLanguage: "en-US,en;q=0.9",
      documentAccept: DOCUMENT_ACCEPT,
      isFirstPartyUrl,
    });
  }

  override async interceptRedirect(
    proposedRequest: Request,
    redirectedResponse: Response,
  ): Promise<Request | undefined> {
    const sourceIsFirstParty = isFirstPartyUrl(redirectedResponse.url);
    const targetIsFirstParty = isFirstPartyUrl(proposedRequest.url);
    if (
      sourceIsFirstParty !== targetIsFirstParty ||
      (sourceIsFirstParty && hostname(redirectedResponse.url) !== hostname(proposedRequest.url))
    ) {
      return undefined;
    }
    return super.interceptRedirect(proposedRequest, redirectedResponse);
  }
}
