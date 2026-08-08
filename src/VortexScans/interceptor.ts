import {
  CloudflareError,
  PaperbackInterceptor,
  URL as PaperbackURL,
  type Request,
  type Response,
} from "@paperback/types";

import { DOMAIN } from "./network.js";

export { CloudflareError };

export const VORTEX_INTERCEPTOR_ID = "vortexScansInterceptor";
export const VORTEX_REFERER = `${DOMAIN}/`;
export const VORTEX_ORIGIN = DOMAIN;
export const VORTEX_ACCEPT_LANGUAGE = "en-US,en;q=0.9";
export const VORTEX_JSON_ACCEPT = "application/json, text/plain, */*";
export const VORTEX_IMAGE_ACCEPT =
  "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8";

const CHALLENGE_STATUSES = new Set([403, 503]);
const IMAGE_EXTENSION = /\.(?:avif|bmp|gif|heic|jpe?g|png|svg|tiff?|webp)(?:$|[?#])/i;
const HTML_CONTENT_TYPE = /(?:^|[;,\s])(?:text\/html|application\/xhtml\+xml)(?:[;\s]|$)/i;
const HTML_TAG = /<!doctype\s+html|<(?:html|head|body|title|script|div)(?:\s|>)/i;

/**
 * Cloudflare's challenge responses have changed shape over time. These are
 * intentionally challenge-specific markers rather than generic words such as
 * "blocked" or "access denied", which are also used by the Vortex API for
 * authentication and locked-chapter errors.
 */
const CHALLENGE_MARKERS = [
  /\bjust a moment\b/i,
  /\bchecking your browser\b/i,
  /\bverify you are human\b/i,
  /\bperforming security verification\b/i,
  /\bchallenge-platform\b/i,
  /\bchallenge-error(?:-title|-text)?\b/i,
  /\b__cf_chl_/i,
  /\bcf-chl-/i,
  /\bcf-browser-verification\b/i,
  /\bcf-im-under-attack\b/i,
  /\bcf-error-overview\b/i,
  /\battention required\b[^<\n]{0,80}\bcloudflare\b/i,
  /\b(?:enable|accept)\s+(?:javascript|cookies)\b/i,
  /\bsecurity check\b/i,
  /\bmanaged challenge\b/i,
  /\bturnstile\b/i,
];

const headerValue = (
  headers: Record<string, string> | undefined,
  name: string,
): string | undefined => {
  if (!headers) return undefined;
  const expected = name.toLowerCase();
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === expected);
  return entry?.[1];
};

const hasHeader = (headers: Record<string, string>, name: string): boolean =>
  Object.keys(headers).some((key) => key.toLowerCase() === name.toLowerCase());

const setHeaderIfMissing = (headers: Record<string, string>, name: string, value: string): void => {
  if (!hasHeader(headers, name)) headers[name] = value;
};

const isVortexHost = (hostname: string): boolean => {
  const normalized = hostname.trim().toLowerCase().replace(/\.$/, "");
  return normalized === "vortexscans.org" || normalized.endsWith(".vortexscans.org");
};

const isVortexRequest = (url: string): boolean => {
  try {
    const parsed = new PaperbackURL(url);
    return (
      parsed.protocol.toLowerCase().replace(/:$/, "") === "https" && isVortexHost(parsed.hostname)
    );
  } catch {
    return false;
  }
};

const isImageRequest = (url: string): boolean => {
  try {
    return IMAGE_EXTENSION.test(new PaperbackURL(url).path);
  } catch {
    return IMAGE_EXTENSION.test(url);
  }
};

const responseBody = (data: ArrayBuffer): string => {
  try {
    return Application.arrayBufferToUTF8String(data);
  } catch {
    return new TextDecoder().decode(data);
  }
};

const containsChallengeEvidence = (body: string): boolean =>
  CHALLENGE_MARKERS.some((marker) => marker.test(body));

const isHtmlChallenge = (response: Response, body: string): boolean => {
  const contentType = headerValue(response.headers, "content-type") ?? "";
  const isHtml = HTML_CONTENT_TYPE.test(contentType) || HTML_TAG.test(body);
  return isHtml && containsChallengeEvidence(body);
};

const isCloudflareChallenge = (response: Response, data: ArrayBuffer): boolean => {
  const mitigated = headerValue(response.headers, "cf-mitigated");
  if (mitigated?.trim().toLowerCase() === "challenge") return true;
  if (!CHALLENGE_STATUSES.has(response.status)) return false;
  return isHtmlChallenge(response, responseBody(data));
};

/**
 * Build a page request that the app can open to complete the Cloudflare
 * challenge. API responses are deliberately resolved through the public page
 * rather than reusing an API URL with an `Accept: application/json` header.
 */
const cloudflareResolutionRequest = (): Request => ({
  url: VORTEX_REFERER,
  method: "GET",
});

export class VortexInterceptor extends PaperbackInterceptor {
  constructor(id: string = VORTEX_INTERCEPTOR_ID) {
    super(id);
  }

  override async interceptRequest(request: Request): Promise<Request> {
    const headers = { ...request.headers };

    // Do not leak source-origin headers to unrelated image hosts. Vortex's
    // storage host is covered by isVortexHost because it is a first-party
    // subdomain.
    if (isVortexRequest(request.url)) {
      setHeaderIfMissing(headers, "referer", VORTEX_REFERER);
      setHeaderIfMissing(headers, "origin", VORTEX_ORIGIN);
      setHeaderIfMissing(headers, "accept-language", VORTEX_ACCEPT_LANGUAGE);
      setHeaderIfMissing(
        headers,
        "accept",
        isImageRequest(request.url) ? VORTEX_IMAGE_ACCEPT : VORTEX_JSON_ACCEPT,
      );
    }

    if (!hasHeader(headers, "user-agent")) {
      setHeaderIfMissing(headers, "user-agent", await Application.getDefaultUserAgent());
    }

    return {
      ...request,
      headers,
    };
  }

  override async interceptResponse(
    request: Request,
    response: Response,
    data: ArrayBuffer,
  ): Promise<ArrayBuffer> {
    if (
      isVortexRequest(request.url) &&
      isVortexRequest(response.url) &&
      isCloudflareChallenge(response, data)
    ) {
      throw new CloudflareError(
        cloudflareResolutionRequest(),
        "Cloudflare verification is required to access Vortex Scans.",
      );
    }

    return data;
  }
}

export { VortexInterceptor as VortexScansInterceptor };
