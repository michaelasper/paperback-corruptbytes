import type { Request, Response } from "@paperback/types";

import {
  DEFAULT_MAX_RESPONSE_BYTES,
  headerValue,
  scheduleBoundedResponse,
  SourceRequestInterceptor,
} from "../shared/http.js";
import { isHttpsUrlForHosts } from "../shared/url.js";
import type { MdxAuthContract } from "./auth.js";
import { ROOT_URL } from "./network.js";

export const MADARADEX_INTERCEPTOR_ID = "madaradexInterceptor";
export const CDN_RETRY_HEADER = "x-paperback-madaradex-auth-retry";
const AUTH_REFRESH_HEADER = "x-mdx-auth-refresh";
const DOCUMENT_ACCEPT = "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8";
const FIRST_PARTY_HOSTS = new Set(["madaradex.org", "www.madaradex.org", "cdn.madaradex.org"]);
const CDN_HOSTS = new Set(["cdn.madaradex.org"]);
const CDN_RETRY_RESPONSE_OPTIONS = {
  sourceName: "MadaraDex CDN",
  maxBodyBytes: DEFAULT_MAX_RESPONSE_BYTES,
  isResponseUrlAllowed: (requestUrl: string, responseUrl: string) =>
    isHttpsUrlForHosts(requestUrl, CDN_HOSTS) && isHttpsUrlForHosts(responseUrl, CDN_HOSTS),
} as const;

const withoutHeader = (
  headers: Record<string, string> | undefined,
  name: string,
): Record<string, string> =>
  Object.fromEntries(Object.entries(headers ?? {}).filter(([key]) => key.toLowerCase() !== name));

export class MadaraDexInterceptor extends SourceRequestInterceptor {
  constructor(
    private readonly auth: MdxAuthContract,
    id: string = MADARADEX_INTERCEPTOR_ID,
  ) {
    super(id, {
      sourceName: "MadaraDex",
      resolutionUrl: ROOT_URL,
      referer: ROOT_URL,
      acceptLanguage: "en-US,en;q=0.9",
      documentAccept: DOCUMENT_ACCEPT,
      isFirstPartyUrl: (value) => isHttpsUrlForHosts(value, FIRST_PARTY_HOSTS),
    });
  }

  override async interceptRequest(request: Request): Promise<Request> {
    const internalRefresh = headerValue(request.headers, AUTH_REFRESH_HEADER) !== undefined;
    const prepared: Request = internalRefresh
      ? { ...request, headers: withoutHeader(request.headers, AUTH_REFRESH_HEADER) }
      : request;
    if (!internalRefresh && isHttpsUrlForHosts(prepared.url, FIRST_PARTY_HOSTS)) {
      await this.auth.ensureAuthenticated();
    }
    const intercepted = await super.interceptRequest(prepared);
    if (isHttpsUrlForHosts(intercepted.url, FIRST_PARTY_HOSTS)) {
      intercepted.headers = { ...intercepted.headers, "sec-fetch-site": "same-site" };
    }

    // Paperback currently gives each registered request interceptor the same
    // object and keeps only the final interceptor's return value. Persist the
    // auth-dependent headers on that shared object so the cookie interceptor,
    // which must run after authentication, cannot discard the CDN referer.
    request.headers = intercepted.headers;
    return request;
  }

  override async interceptResponse(
    request: Request,
    response: Response,
    data: ArrayBuffer,
  ): Promise<ArrayBuffer> {
    if (response.status === 403 && isHttpsUrlForHosts(response.url || request.url, CDN_HOSTS)) {
      if (headerValue(request.headers, CDN_RETRY_HEADER) !== undefined) {
        throw new Error("MadaraDex CDN authorization failed after one retry.");
      }
      await this.auth.refresh(true);
      const retryRequest: Request = {
        ...request,
        headers: { ...request.headers, [CDN_RETRY_HEADER]: "1", "cache-control": "no-store" },
      };
      const { response: retryResponse, data: retryData } = await scheduleBoundedResponse(
        retryRequest,
        CDN_RETRY_RESPONSE_OPTIONS,
      );
      if (retryResponse.status < 200 || retryResponse.status >= 300) {
        throw new Error(
          `MadaraDex CDN authorization failed after one retry (${retryResponse.status}).`,
        );
      }
      // The interceptor contract returns only replacement bytes, while
      // scheduleRequest returns this original response object to its caller.
      // Mirror the successful retry metadata so Paperback does not discard the
      // recovered image because the outer response still says 403.
      Object.assign(response, {
        url: retryResponse.url,
        headers: retryResponse.headers,
        status: retryResponse.status,
        cookies: retryResponse.cookies,
        mimeType: retryResponse.mimeType,
      });
      return retryData;
    }
    return super.interceptResponse(request, response, data);
  }
}
