import type { Request, Response } from "@paperback/types";

import { responseStatus, SourceRequestInterceptor } from "../shared/http.js";
import {
  AJAX_ACCEPT,
  AJAX_CONTENT_TYPE,
  AJAX_URL,
  MAX_MEDIA_RESPONSE_BYTES,
  ROOT_URL,
  canonicalSeriesSlug,
  isRinkoCoverUrl,
  isRinkoImageContentType,
  isRinkoMediaUrl,
  isRinkoReadUrl,
  isRinkoSiteUrl,
  isValidRinkoAjaxBody,
  isValidRinkoHeaderValue,
  rinkoResponseHeaders,
} from "./network.js";

const MAX_HEADERS = 256;
const arrayBufferByteLengthGetter: unknown = (
  Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength") as
    | { get?: unknown }
    | undefined
)?.get;
const arrayBufferResizableGetter: unknown = (
  Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "resizable") as
    | { get?: unknown }
    | undefined
)?.get;
const IntrinsicUint8Array = Uint8Array;
const MAX_HEADER_NAME_LENGTH = 256;
const SITE_HEADERS = new Set([
  "accept",
  "accept-language",
  "cache-control",
  "content-type",
  "if-modified-since",
  "if-none-match",
  "origin",
  "referer",
  "user-agent",
  "x-requested-with",
]);
const MEDIA_HEADERS = new Set([
  "accept",
  "accept-language",
  "cache-control",
  "if-modified-since",
  "if-none-match",
  "range",
  "user-agent",
]);
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const HEADER_FAILURE = Symbol("RinkoHeaderFailure");
const HEADER_LIMIT_FAILURE = Symbol("RinkoHeaderLimitFailure");

const sanitizedHeaders = (
  value: unknown,
  allowlist: ReadonlySet<string>,
): Record<string, string> => {
  if (value === undefined) return {};
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw HEADER_FAILURE;
    }
  } catch {
    throw new Error("Rinko Comics request headers are invalid.");
  }
  const output: Record<string, string> = {};
  const seen = new Set<string>();
  try {
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length > MAX_HEADERS) throw HEADER_LIMIT_FAILURE;
    const ownNames = new Set<string>();
    for (const key of ownKeys) {
      if (typeof key !== "string" || !Object.prototype.propertyIsEnumerable.call(value, key)) {
        throw HEADER_FAILURE;
      }
      ownNames.add(key);
    }
    let inspected = 0;
    const enumeratedOwnNames = new Set<string>();
    for (const name in value) {
      inspected += 1;
      if (inspected > MAX_HEADERS) throw HEADER_LIMIT_FAILURE;
      if (name.length < 1 || name.length > MAX_HEADER_NAME_LENGTH || !HEADER_NAME.test(name)) {
        throw HEADER_FAILURE;
      }
      const isOwn = Object.prototype.hasOwnProperty.call(value, name);
      if (isOwn) {
        if (!ownNames.has(name)) throw HEADER_FAILURE;
        enumeratedOwnNames.add(name);
      }
      const normalized = name.toLowerCase();
      const header = (value as Record<string, unknown>)[name];
      if (!isValidRinkoHeaderValue(header) || seen.has(normalized)) {
        throw HEADER_FAILURE;
      }
      seen.add(normalized);
      if (isOwn && allowlist.has(normalized)) output[normalized] = header;
    }
    if (enumeratedOwnNames.size !== ownNames.size) throw HEADER_FAILURE;
  } catch (error: unknown) {
    if (error === HEADER_LIMIT_FAILURE) {
      throw new Error("Rinko Comics request has too many headers.");
    }
    throw new Error("Rinko Comics request headers are invalid.");
  }
  return output;
};

interface RequestSnapshot {
  url: unknown;
  method: unknown;
  headers: unknown;
  body: unknown;
}

const fixedArrayBufferByteLength = (value: unknown): number | undefined => {
  try {
    if (typeof arrayBufferByteLengthGetter !== "function") return undefined;
    const byteLength = Reflect.apply(arrayBufferByteLengthGetter, value, []) as number;
    if (!Number.isSafeInteger(byteLength) || byteLength < 0) return undefined;
    if (typeof arrayBufferResizableGetter === "function") {
      const resizable = Reflect.apply(arrayBufferResizableGetter, value, []) as unknown;
      if (resizable !== false) return undefined;
    }
    new IntrinsicUint8Array(value as ArrayBuffer, 0, 0);
    return byteLength;
  } catch {
    return undefined;
  }
};

const snapshotRequest = (request: unknown): RequestSnapshot => {
  try {
    if (typeof request !== "object" || request === null) {
      throw HEADER_FAILURE;
    }
    const value = request as Partial<Request>;
    return {
      url: value.url,
      method: value.method,
      headers: value.headers,
      body: value.body,
    };
  } catch {
    throw new Error("Rinko Comics request is invalid.");
  }
};

const cleanRequest = (request: Request, allowInjectedHeaders = false): Request => {
  const snapshot = snapshotRequest(request);
  const url = snapshot.url;
  const method = snapshot.method;
  const site = isRinkoSiteUrl(url);
  const media = isRinkoMediaUrl(url);
  if (!site && !media) throw new Error("Rinko Comics request URL is not trusted.");
  if (typeof method !== "string" || !/^(?:GET|HEAD|POST)$/i.test(method)) {
    throw new Error("Rinko Comics request method is invalid.");
  }
  const normalizedMethod = method.toUpperCase();
  if (site && normalizedMethod !== "POST" && !isRinkoReadUrl(url)) {
    throw new Error("Rinko Comics request URL is not trusted.");
  }
  if (media && normalizedMethod === "POST") {
    throw new Error("Rinko Comics media requests must be credential-neutral reads.");
  }
  if (normalizedMethod === "POST" && url !== AJAX_URL) {
    throw new Error("Rinko Comics POST request URL is invalid.");
  }
  if (normalizedMethod === "POST") {
    if (
      typeof snapshot.body !== "string" ||
      snapshot.body.length > 4_096 ||
      !isValidRinkoAjaxBody(snapshot.body)
    ) {
      throw new Error("Rinko Comics POST request body is invalid.");
    }
  } else if (snapshot.body !== undefined) {
    throw new Error("Rinko Comics read requests must not include a body.");
  }
  const headers = sanitizedHeaders(snapshot.headers, media ? MEDIA_HEADERS : SITE_HEADERS);
  if (!allowInjectedHeaders) delete headers["user-agent"];
  if (normalizedMethod === "POST") {
    const allowedPostHeaders = new Set([
      "accept",
      "content-type",
      "origin",
      "referer",
      "x-requested-with",
      ...(allowInjectedHeaders ? ["accept-language", "user-agent"] : []),
    ]);
    let hasUnexpectedHeader = false;
    for (const name in headers) {
      if (!Object.prototype.hasOwnProperty.call(headers, name) || !allowedPostHeaders.has(name)) {
        hasUnexpectedHeader = true;
        break;
      }
    }
    if (
      hasUnexpectedHeader ||
      headers.accept !== AJAX_ACCEPT ||
      headers["content-type"] !== AJAX_CONTENT_TYPE ||
      headers.origin !== ROOT_URL.slice(0, -1) ||
      headers["x-requested-with"] !== "XMLHttpRequest" ||
      typeof headers.referer !== "string" ||
      !isRinkoReadUrl(headers.referer) ||
      canonicalSeriesSlug(headers.referer) === undefined ||
      (allowInjectedHeaders && headers["accept-language"] !== "en-US,en;q=0.9")
    ) {
      throw new Error("Rinko Comics AJAX request headers are invalid.");
    }
  } else {
    delete headers.origin;
    if (!allowInjectedHeaders) delete headers.referer;
    else if (headers.referer !== undefined && headers.referer !== ROOT_URL) {
      throw new Error("Rinko Comics injected request headers are invalid.");
    }
    delete headers["content-type"];
    delete headers["x-requested-with"];
  }
  return {
    url,
    method: normalizedMethod,
    headers,
    ...(normalizedMethod === "POST" && { body: snapshot.body as string }),
  };
};

const synchronizeSharedRequest = (target: Request, source: Request): void => {
  try {
    target.url = source.url;
    target.method = source.method;
    target.headers = { ...source.headers };
    if (source.body === undefined) delete target.body;
    else target.body = source.body;
    delete target.cookies;
  } catch {
    // The returned reconstruction remains safe even if a hostile/frozen caller
    // prevents Paperback's shared request object from being updated in place.
  }
};

export class RinkoComicsInterceptor extends SourceRequestInterceptor {
  constructor() {
    super("rinkoComicsInterceptor", {
      sourceName: "Rinko Comics",
      resolutionUrl: ROOT_URL,
      isFirstPartyUrl: isRinkoSiteUrl,
      referer: ROOT_URL,
      acceptLanguage: "en-US,en;q=0.9",
      documentAccept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
    });
  }

  override async interceptRequest(request: Request): Promise<Request> {
    const clean = cleanRequest(request);
    synchronizeSharedRequest(request, clean);
    let intercepted: Request;
    try {
      intercepted = await super.interceptRequest(clean);
    } catch {
      throw new Error("Rinko Comics request interception failed safely.");
    }
    const result = cleanRequest(intercepted, true);
    synchronizeSharedRequest(request, result);
    return result;
  }

  override async interceptRedirect(
    proposedRequest: Request,
    redirectedResponse: Response,
  ): Promise<Request | undefined> {
    try {
      const proposed = snapshotRequest(proposedRequest);
      const sourceUrl = redirectedResponse?.url;
      const targetUrl = proposed.url;
      const sourceCover = isRinkoCoverUrl(sourceUrl);
      const targetCover = isRinkoCoverUrl(targetUrl);
      const sameDocumentSite =
        isRinkoReadUrl(sourceUrl) && isRinkoReadUrl(targetUrl) && !sourceCover && !targetCover;
      const sameCover = sourceCover && targetCover;
      const sameMedia = isRinkoMediaUrl(sourceUrl) && isRinkoMediaUrl(targetUrl);
      if (!sameDocumentSite && !sameCover && !sameMedia) return undefined;
      if (typeof proposed.method !== "string" || !/^(?:GET|HEAD)$/i.test(proposed.method)) {
        return undefined;
      }
      return await this.interceptRequest(proposedRequest);
    } catch {
      return undefined;
    }
  }

  override async interceptResponse(
    request: Request,
    response: Response,
    data: ArrayBuffer,
  ): Promise<ArrayBuffer> {
    try {
      const byteLength = fixedArrayBufferByteLength(data);
      if (byteLength === undefined) throw HEADER_FAILURE;
      const requestSnapshot = snapshotRequest(request);
      if (fixedArrayBufferByteLength(data) !== byteLength) throw HEADER_FAILURE;
      const requestUrl = requestSnapshot.url;
      const responseUrl = response?.url;
      if (typeof responseUrl !== "string" || fixedArrayBufferByteLength(data) !== byteLength) {
        throw HEADER_FAILURE;
      }
      const requestCover = isRinkoCoverUrl(requestUrl);
      const responseCover = isRinkoCoverUrl(responseUrl);
      const sameDocumentSite =
        requestUrl === responseUrl &&
        isRinkoReadUrl(requestUrl) &&
        isRinkoReadUrl(responseUrl) &&
        !requestCover &&
        !responseCover;
      const sameAjax = requestUrl === AJAX_URL && responseUrl === AJAX_URL;
      const sameImage =
        (requestCover && responseCover) ||
        (isRinkoMediaUrl(requestUrl) && isRinkoMediaUrl(responseUrl));
      if (!sameDocumentSite && !sameAjax && !sameImage) throw HEADER_FAILURE;
      if (sameDocumentSite) {
        if (
          typeof requestSnapshot.method !== "string" ||
          !/^(?:GET|HEAD)$/i.test(requestSnapshot.method) ||
          requestSnapshot.body !== undefined
        ) {
          throw HEADER_FAILURE;
        }
      } else if (sameAjax) {
        if (
          typeof requestSnapshot.method !== "string" ||
          !/^POST$/i.test(requestSnapshot.method) ||
          !isValidRinkoAjaxBody(requestSnapshot.body)
        ) {
          throw HEADER_FAILURE;
        }
      } else {
        if (
          typeof requestSnapshot.method !== "string" ||
          !/^(?:GET|HEAD)$/i.test(requestSnapshot.method) ||
          requestSnapshot.body !== undefined ||
          byteLength > MAX_MEDIA_RESPONSE_BYTES
        ) {
          throw HEADER_FAILURE;
        }
        const status = responseStatus(response);
        if (status === undefined || status < 200 || status >= 300) throw HEADER_FAILURE;
        const headers = rinkoResponseHeaders(response.headers, ["content-type"]);
        if (!isRinkoImageContentType(headers["content-type"])) throw HEADER_FAILURE;
      }
      if (fixedArrayBufferByteLength(data) !== byteLength) throw HEADER_FAILURE;
      return data;
    } catch {
      throw new Error("Rinko Comics returned an untrusted response.");
    }
  }
}
