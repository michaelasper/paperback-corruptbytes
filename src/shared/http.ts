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
export const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1_024 * 1_024;

const CHALLENGE_STATUSES = new Set([403, 503]);
const MAX_CHALLENGE_INSPECTION_BYTES = 256 * 1_024;
const IMAGE_EXTENSION = /\.(?:avif|bmp|gif|heic|jpe?g|png|svg|tiff?|webp)(?:$|[?#])/i;
const HTML_CONTENT_TYPE = /(?:^|[;,\s])(?:text\/html|application\/xhtml\+xml)(?:[;\s]|$)/i;
const UNTRUSTED_SENSITIVE_HEADERS = new Set(["authorization", "cookie", "origin", "referer"]);
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

const REQUEST_CONTEXT_MAX_LENGTH = 512;

const sanitizeRequestContext = (value: string): string => {
  let result = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined || codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f)) {
      continue;
    }
    if (result.length + character.length > REQUEST_CONTEXT_MAX_LENGTH) break;
    result += character;
  }
  return result.trim();
};

/** Keep only safe origin/path context for errors; never retain userinfo, query, or fragment data. */
export const requestContext = (value: string): string => {
  try {
    const parsed = new PaperbackURL(value);
    const protocol = parsed.protocol.toLowerCase().replace(/:$/, "");
    const hostname = parsed.hostname.toLowerCase();
    if (!protocol || !hostname) throw new Error("URL authority is missing.");
    const authority = `${hostname}${parsed.port ? `:${parsed.port}` : ""}`;
    const path = parsed.path || "";
    return sanitizeRequestContext(
      `${protocol}://${authority}${path.startsWith("/") || !path ? path : `/${path}`}`,
    );
  } catch {
    const withoutCredentials = value
      .replace(/^([a-z][a-z\d+.-]*:\/\/)[^/?#]*@/i, "$1")
      .replace(
        /^(\/\/)?[^/?#\s@]*@/,
        (_match: string, slashes: string | undefined) => slashes ?? "",
      )
      .replace(/[?#][\s\S]*$/, "");
    return sanitizeRequestContext(withoutCredentials);
  }
};

const isImageRequest = (url: string): boolean => {
  try {
    return IMAGE_EXTENSION.test(new PaperbackURL(url).path);
  } catch {
    return IMAGE_EXTENSION.test(url);
  }
};

const stripUntrustedSensitiveHeaders = (headers: Record<string, string>): void => {
  for (const name of Object.keys(headers)) {
    if (UNTRUSTED_SENSITIVE_HEADERS.has(name.toLowerCase())) delete headers[name];
  }
};

const isSafeHttpsUrl = (value: string): boolean => {
  try {
    const parsed = new PaperbackURL(value);
    return (
      parsed.protocol.toLowerCase().replace(/:$/, "") === "https" &&
      Boolean(parsed.hostname) &&
      !parsed.username &&
      !parsed.password
    );
  } catch {
    return false;
  }
};

/** Remove credentials before allowing a neutral third-party redirect to continue. */
const sanitizeNeutralRedirect = (request: Request): Request => {
  const sanitized: Request = { ...request };
  if (request.headers) {
    sanitized.headers = { ...request.headers };
    stripUntrustedSensitiveHeaders(sanitized.headers);
  }
  delete sanitized.cookies;
  delete sanitized.body;
  return sanitized;
};

const isSafeNeutralRedirectMethod = (method: string): boolean => {
  const normalized = method.trim().toUpperCase();
  return normalized === "GET" || normalized === "HEAD";
};

export const decodeResponseBody = (data: ArrayBuffer): string => {
  try {
    return Application.arrayBufferToUTF8String(data);
  } catch {
    return new TextDecoder().decode(data);
  }
};

export interface SourceResponseOptions {
  sourceName: string;
  maxBodyBytes?: number;
  /** Optionally require both the requested and final response URLs to remain trusted. */
  isResponseUrlAllowed?: (requestUrl: string, responseUrl: string) => boolean;
}

/** A body-free HTTP failure whose status can be classified without parsing user-facing text. */
export class SourceHttpError extends Error {
  readonly sourceName: string;
  readonly status: number;

  constructor(sourceName: string, status: number) {
    const message =
      status === 404
        ? `${sourceName} content was not found.`
        : status === 429
          ? `${sourceName} rate limit reached. Please wait and try again.`
          : `${sourceName} request failed with status ${status}.`;
    super(message);
    this.name = "SourceHttpError";
    this.sourceName = sourceName;
    this.status = status;
  }
}

const responseLimit = (options: SourceResponseOptions): number => {
  const value = options.maxBodyBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${options.sourceName} response limit must be a positive safe integer.`);
  }
  return value;
};

export interface ScheduledRawResponse {
  response: Response;
  data: ArrayBuffer;
}

/** Schedule a raw response after enforcing both the initial and final URL boundary. */
export const scheduleRawResponse = async (
  request: Request,
  options: SourceResponseOptions,
): Promise<ScheduledRawResponse> => {
  const isResponseUrlAllowed = options.isResponseUrlAllowed;
  if (isResponseUrlAllowed && !isResponseUrlAllowed(request.url, request.url)) {
    throw new Error(`${options.sourceName} response URL was not trusted.`);
  }
  const [response, data] = await Application.scheduleRequest(request);
  if (isResponseUrlAllowed && !isResponseUrlAllowed(request.url, response.url)) {
    throw new Error(`${options.sourceName} response URL was not trusted.`);
  }
  return { response, data };
};

/** Reject a raw response before any text decoder or downstream consumer sees it. */
export const assertResponseBodyWithinLimit = (
  data: ArrayBuffer,
  options: SourceResponseOptions,
): void => {
  if (data.byteLength > responseLimit(options)) {
    throw new Error(`${options.sourceName} response was too large to process safely.`);
  }
};

/** Schedule a raw response while enforcing its absolute byte limit. */
export const scheduleBoundedResponse = async (
  request: Request,
  options: SourceResponseOptions,
): Promise<ScheduledRawResponse> => {
  const result = await scheduleRawResponse(request, options);
  assertResponseBodyWithinLimit(result.data, options);
  return result;
};

/** Schedule and decode a response only after enforcing an absolute byte limit. */
export const scheduleTextResponse = async (
  request: Request,
  options: SourceResponseOptions,
): Promise<{ response: Response; body: string }> => {
  const { response, data } = await scheduleBoundedResponse(request, options);
  return { response, body: decodeResponseBody(data) };
};

const assertSuccessfulStatus = (response: Response, options: SourceResponseOptions): void => {
  if (response.status < 200 || response.status >= 300) {
    throw new SourceHttpError(options.sourceName, response.status);
  }
};

/** Fetch bounded text with consistent, body-free HTTP errors. */
export const fetchSourceText = async (
  request: Request,
  options: SourceResponseOptions,
): Promise<string> => {
  const { response, data } = await scheduleRawResponse(request, options);
  assertSuccessfulStatus(response, options);
  assertResponseBodyWithinLimit(data, options);
  return decodeResponseBody(data);
};

/** Fetch bounded text with response metadata, rejecting non-success statuses before decoding. */
export const fetchSourceTextResponse = async (
  request: Request,
  options: SourceResponseOptions,
): Promise<{ response: Response; body: string }> => {
  const { response, data } = await scheduleRawResponse(request, options);
  assertSuccessfulStatus(response, options);
  assertResponseBodyWithinLimit(data, options);
  return { response, body: decodeResponseBody(data) };
};

const HTML_DOCUMENT = /^\s*(?:<!doctype\s+html\b|<html\b|<head\b|<body\b|<title\b)/i;

/** Fetch and decode bounded JSON while distinguishing HTML fallback pages. */
export const fetchSourceJson = async <T = unknown>(
  request: Request,
  options: SourceResponseOptions,
): Promise<T> => {
  const body = await fetchSourceText(request, options);
  if (HTML_DOCUMENT.test(body)) {
    throw new Error(`${options.sourceName} returned HTML instead of JSON.`);
  }
  try {
    return JSON.parse(body) as T;
  } catch (error: unknown) {
    throw new Error(`${options.sourceName} returned invalid JSON.`, { cause: error });
  }
};

export const isCloudflareChallenge = (response: Response, data: ArrayBuffer): boolean => {
  if (headerValue(response.headers, "cf-mitigated")?.trim().toLowerCase() === "challenge") {
    return true;
  }
  if (!CHALLENGE_STATUSES.has(response.status)) return false;
  if (data.byteLength > MAX_CHALLENGE_INSPECTION_BYTES) return false;

  const body = decodeResponseBody(data);
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

type RedirectApplication = {
  Selector?: (base: object, key: string) => unknown;
  setRedirectHandler?: (selector: unknown) => void;
};

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

  override registerInterceptor(): void {
    super.registerInterceptor();
    if (typeof globalThis.Application === "undefined") return;
    const application = globalThis.Application as unknown as RedirectApplication;
    if (application.Selector && application.setRedirectHandler) {
      application.setRedirectHandler(application.Selector(this, "interceptRedirect"));
    }
  }

  async interceptRedirect(
    proposedRequest: Request,
    redirectedResponse: Response,
  ): Promise<Request | undefined> {
    const responseIsFirstParty = this.options.isFirstPartyUrl(redirectedResponse.url);
    if (responseIsFirstParty) {
      return this.options.isFirstPartyUrl(proposedRequest.url) ? proposedRequest : undefined;
    }

    // Image/CDN URLs are intentionally neutral. They may redirect across CDN hosts, but
    // must stay encrypted and can never carry source or caller credentials. Only bodyless
    // navigation methods are allowed so a neutral cross-host redirect cannot replay a POST.
    return isSafeNeutralRedirectMethod(proposedRequest.method) &&
      isSafeHttpsUrl(redirectedResponse.url) &&
      isSafeHttpsUrl(proposedRequest.url)
      ? sanitizeNeutralRedirect(proposedRequest)
      : undefined;
  }

  override async interceptRequest(request: Request): Promise<Request> {
    const headers = { ...request.headers };
    const isFirstParty = this.options.isFirstPartyUrl(request.url);

    if (isFirstParty) {
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
    } else {
      stripUntrustedSensitiveHeaders(headers);
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
