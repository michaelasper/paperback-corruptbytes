import { URL as PaperbackURL, type Request, type Response } from "@paperback/types";

import { SourceRequestInterceptor } from "../shared/http.js";
import { isHttpsUrlForHosts } from "../shared/url.js";
import { DOMAIN, isNeutralMediaUrl, isPublicFallbackAssetUrl } from "./network.js";

export const QIMANGA_INTERCEPTOR_ID = "qiMangaInterceptor";
const FIRST_PARTY_HOSTS = new Set(["qimanga.com", "www.qimanga.com", "api.qimanga.com"]);
const DOCUMENT_ACCEPT = "application/json,text/plain;q=0.9,text/html;q=0.8,*/*;q=0.7";
const NEUTRAL_HEADER_NAMES = new Set([
  "accept",
  "accept-encoding",
  "accept-language",
  "cache-control",
  "if-match",
  "if-modified-since",
  "if-none-match",
  "if-unmodified-since",
  "range",
  "user-agent",
]);

const isFirstPartyUrl = (value: string): boolean =>
  typeof value === "string" &&
  value.length <= 2_048 &&
  isHttpsUrlForHosts(value, FIRST_PARTY_HOSTS) &&
  !isPublicFallbackAssetUrl(value);

const isNeutralAssetUrl = (value: string): boolean =>
  isPublicFallbackAssetUrl(value) || isNeutralMediaUrl(value);

const hostname = (value: string): string | undefined => {
  try {
    return new PaperbackURL(value).hostname.toLowerCase();
  } catch {
    return undefined;
  }
};

const neutralRequest = (request: Request): Request => {
  let headers: Record<string, string> = {};
  try {
    headers = Object.fromEntries(
      Object.entries(request.headers ?? {}).filter(
        ([name, value]) =>
          typeof value === "string" && NEUTRAL_HEADER_NAMES.has(name.toLowerCase()),
      ),
    );
  } catch {
    // A malformed caller header map fails toward removing every header.
  }
  return { url: request.url, method: request.method, headers };
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

  override async interceptRequest(request: Request): Promise<Request> {
    const intercepted = await super.interceptRequest(request);
    if (isFirstPartyUrl(intercepted.url)) return intercepted;
    return neutralRequest(intercepted);
  }

  override async interceptRedirect(
    proposedRequest: Request,
    redirectedResponse: Response,
  ): Promise<Request | undefined> {
    try {
      const sourceUrl = redirectedResponse.url;
      const targetUrl = proposedRequest.url;
      const sourceIsFirstParty = isFirstPartyUrl(sourceUrl);
      const targetIsFirstParty = isFirstPartyUrl(targetUrl);
      if (sourceIsFirstParty) {
        if (!targetIsFirstParty || hostname(sourceUrl) !== hostname(targetUrl)) {
          return undefined;
        }
        return super.interceptRedirect(proposedRequest, redirectedResponse);
      }

      if (!isNeutralAssetUrl(sourceUrl) || !isNeutralAssetUrl(targetUrl)) {
        return undefined;
      }
      const redirected = await super.interceptRedirect(proposedRequest, redirectedResponse);
      return redirected ? neutralRequest(redirected) : undefined;
    } catch {
      return undefined;
    }
  }
}
