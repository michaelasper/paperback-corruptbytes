import {
  CloudflareError,
  PaperbackInterceptor,
  URL as PaperbackURL,
  type Request,
  type Response,
} from "@paperback/types";

export { CloudflareError };

export const DEFAULT_IMAGE_ACCEPT =
  "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8";

const CHALLENGE_STATUSES = new Set([403, 503]);
const IMAGE_EXTENSION = /\.(?:avif|bmp|gif|heic|jpe?g|png|svg|tiff?|webp)(?:$|[?#])/i;
const HTML_CONTENT_TYPE = /(?:^|[;,\s])(?:text\/html|application\/xhtml\+xml)(?:[;\s]|$)/i;
const HTML_TAG = /<!doctype\s+html|<(?:html|head|body|title|script|div)(?:\s|>)/i;
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

export const headerValue = (
  headers: Record<string, string> | undefined,
  name: string,
): string | undefined =>
  Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];

export const setHeaderIfMissing = (
  headers: Record<string, string>,
  name: string,
  value: string,
): void => {
  if (headerValue(headers, name) === undefined) headers[name] = value;
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

export const isCloudflareChallenge = (response: Response, data: ArrayBuffer): boolean => {
  if (headerValue(response.headers, "cf-mitigated")?.trim().toLowerCase() === "challenge") {
    return true;
  }
  if (!CHALLENGE_STATUSES.has(response.status)) return false;

  const body = responseBody(data);
  const contentType = headerValue(response.headers, "content-type") ?? "";
  const isHtml = HTML_CONTENT_TYPE.test(contentType) || HTML_TAG.test(body);
  return isHtml && CHALLENGE_MARKERS.some((marker) => marker.test(body));
};

export interface SourceRequestInterceptorOptions {
  sourceName: string;
  resolutionUrl: string;
  isFirstPartyUrl(value: string): boolean;
  referer?: string;
  origin?: string;
  acceptLanguage?: string;
  documentAccept?: string;
  imageAccept?: string;
}

/**
 * Shared source transport policy. Source-specific headers never leave the
 * explicitly trusted origin, while a neutral user agent remains available to
 * image CDNs used by the reader.
 */
export class SourceRequestInterceptor extends PaperbackInterceptor {
  constructor(
    id: string,
    private readonly options: SourceRequestInterceptorOptions,
  ) {
    super(id);
  }

  override async interceptRequest(request: Request): Promise<Request> {
    const headers = { ...request.headers };

    if (this.options.isFirstPartyUrl(request.url)) {
      if (this.options.referer) setHeaderIfMissing(headers, "referer", this.options.referer);
      if (this.options.origin) setHeaderIfMissing(headers, "origin", this.options.origin);
      if (this.options.acceptLanguage) {
        setHeaderIfMissing(headers, "accept-language", this.options.acceptLanguage);
      }
      if (this.options.documentAccept) {
        setHeaderIfMissing(
          headers,
          "accept",
          isImageRequest(request.url)
            ? (this.options.imageAccept ?? DEFAULT_IMAGE_ACCEPT)
            : this.options.documentAccept,
        );
      }
    }

    setHeaderIfMissing(headers, "user-agent", await Application.getDefaultUserAgent());

    return { ...request, headers };
  }

  override async interceptResponse(
    request: Request,
    response: Response,
    data: ArrayBuffer,
  ): Promise<ArrayBuffer> {
    if (
      this.options.isFirstPartyUrl(request.url) &&
      this.options.isFirstPartyUrl(response.url) &&
      isCloudflareChallenge(response, data)
    ) {
      throw new CloudflareError(
        { url: this.options.resolutionUrl, method: "GET" },
        `Cloudflare verification is required to access ${this.options.sourceName}.`,
      );
    }

    return data;
  }
}
