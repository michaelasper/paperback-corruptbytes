import { SourceRequestInterceptor } from "../shared/http.js";
import { isHttpsUrlForDomain } from "../shared/url.js";
import { DOMAIN } from "./network.js";

export { CloudflareError } from "../shared/http.js";

export const VORTEX_INTERCEPTOR_ID = "vortexScansInterceptor";
export const VORTEX_REFERER = `${DOMAIN}/`;
export const VORTEX_ORIGIN = DOMAIN;
export const VORTEX_ACCEPT_LANGUAGE = "en-US,en;q=0.9";
export const VORTEX_JSON_ACCEPT = "application/json, text/plain, */*";
export const VORTEX_IMAGE_ACCEPT =
  "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8";

/** Source-specific configuration for the repository's shared transport policy. */
export class VortexInterceptor extends SourceRequestInterceptor {
  constructor(id: string = VORTEX_INTERCEPTOR_ID) {
    super(id, {
      sourceName: "Vortex Scans",
      resolutionUrl: VORTEX_REFERER,
      referer: VORTEX_REFERER,
      origin: VORTEX_ORIGIN,
      acceptLanguage: VORTEX_ACCEPT_LANGUAGE,
      documentAccept: VORTEX_JSON_ACCEPT,
      imageAccept: VORTEX_IMAGE_ACCEPT,
      isFirstPartyUrl: (value) => isHttpsUrlForDomain(value, "vortexscans.org"),
    });
  }
}

export { VortexInterceptor as VortexScansInterceptor };
