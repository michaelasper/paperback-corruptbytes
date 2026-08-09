import type { Cookie } from "@paperback/types";

import { assertResponseBodyWithinLimit, scheduleRawResponse } from "../shared/http.js";
import { isHttpsUrlForHosts } from "../shared/url.js";
import { isMadaraDexCookie } from "./cookies.js";
import { buildRefreshRequest } from "./network.js";

export interface MadaraCookieStore {
  readonly cookies: Readonly<Cookie[]>;
  setCookie(cookie: Cookie): void;
  deleteCookie(cookie: Cookie): void;
  acceptSensitiveCookies?(): void;
  invalidateSensitiveCookies?(): void;
}

export interface MdxAuthContract {
  ensureAuthenticated(): Promise<void>;
  refresh(force?: boolean): Promise<void>;
  isAuthenticated(): boolean;
}

interface MdxAuthOptions {
  randomBytes?: () => Uint8Array;
  now?: () => number;
  refreshTimeoutMs?: number;
}

const FINGERPRINT_LIFETIME_MS = 30 * 24 * 60 * 60_000;
export const MADARA_REFRESH_TIMEOUT_MS = 15_000;
const AUTH_RESPONSE_HOSTS = new Set(["madaradex.org", "www.madaradex.org"]);
const AUTH_RESPONSE_OPTIONS = {
  sourceName: "MadaraDex authentication",
  maxBodyBytes: 256 * 1_024,
  isResponseUrlAllowed: (requestUrl: string, responseUrl: string) =>
    isHttpsUrlForHosts(requestUrl, AUTH_RESPONSE_HOSTS) &&
    isHttpsUrlForHosts(responseUrl, AUTH_RESPONSE_HOSTS),
} as const;
const EXPIRY_SKEW_MS = 30_000;

const normalizedName = (cookie: Cookie): string => cookie.name.trim().toLowerCase();

const isUnexpired = (cookie: Cookie, now: number): boolean =>
  !cookie.expires || cookie.expires.getTime() > now + EXPIRY_SKEW_MS;

const randomFingerprint = (randomBytes?: () => Uint8Array): string => {
  const bytes = randomBytes?.() ?? globalThis.crypto.getRandomValues(new Uint8Array(16));
  if (bytes.length !== 16) throw new Error("MadaraDex fingerprint entropy must be 16 bytes.");
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
};

export class MdxAuthManager implements MdxAuthContract {
  private refreshInFlight: Promise<void> | undefined;
  private readonly now: () => number;
  private readonly refreshTimeoutMs: number;

  constructor(
    private readonly store: MadaraCookieStore,
    private readonly options: MdxAuthOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.refreshTimeoutMs =
      Number.isFinite(options.refreshTimeoutMs) && (options.refreshTimeoutMs ?? 0) > 0
        ? Math.max(1, Math.trunc(options.refreshTimeoutMs as number))
        : MADARA_REFRESH_TIMEOUT_MS;
  }

  isAuthenticated(): boolean {
    return Boolean(this.validCookie("mdx_fp") && this.validCookie("mdx_auth"));
  }

  async ensureAuthenticated(): Promise<void> {
    if (this.isAuthenticated()) return;
    await this.refresh(false);
  }

  async refresh(force: boolean = false): Promise<void> {
    if (!force && this.isAuthenticated()) return;
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = this.performRefresh(force).finally(() => {
      this.refreshInFlight = undefined;
    });
    return this.refreshInFlight;
  }

  private validCookie(name: "mdx_auth" | "mdx_fp"): Cookie | undefined {
    const now = this.now();
    return this.store.cookies.find(
      (cookie) =>
        normalizedName(cookie) === name && isMadaraDexCookie(cookie) && isUnexpired(cookie, now),
    );
  }

  private removeNamed(name: "mdx_auth" | "mdx_fp"): void {
    for (const cookie of this.store.cookies) {
      if (normalizedName(cookie) === name) this.store.deleteCookie(cookie);
    }
  }

  private ensureFingerprint(): Cookie {
    const existing = this.validCookie("mdx_fp");
    if (existing) return existing;
    this.removeNamed("mdx_fp");
    const fingerprint: Cookie = {
      name: "mdx_fp",
      value: randomFingerprint(this.options.randomBytes),
      domain: "madaradex.org",
      path: "/",
      created: new Date(this.now()),
      expires: new Date(this.now() + FINGERPRINT_LIFETIME_MS),
    };
    this.store.setCookie(fingerprint);
    return fingerprint;
  }

  private async performRefresh(force: boolean): Promise<void> {
    try {
      const fingerprint = this.ensureFingerprint();
      if (force || !this.validCookie("mdx_auth")) {
        if (this.store.invalidateSensitiveCookies && this.store.acceptSensitiveCookies) {
          this.store.invalidateSensitiveCookies();
          this.store.acceptSensitiveCookies();
        } else {
          this.removeNamed("mdx_auth");
        }
      }
      const request = buildRefreshRequest();
      request.cookies = Object.fromEntries(
        this.store.cookies
          .filter((cookie) => isMadaraDexCookie(cookie) && isUnexpired(cookie, this.now()))
          .map((cookie) => [cookie.name, cookie.value]),
      );
      request.cookies.mdx_fp = fingerprint.value;

      const { response, data } = await this.scheduleRefresh(request);
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`MadaraDex authentication refresh failed with status ${response.status}.`);
      }
      assertResponseBodyWithinLimit(data, AUTH_RESPONSE_OPTIONS);
      for (const cookie of response.cookies) {
        if (isMadaraDexCookie(cookie)) this.store.setCookie(cookie);
      }
      if (!this.validCookie("mdx_auth")) {
        throw new Error("MadaraDex authentication refresh did not issue mdx_auth.");
      }
    } catch (error: unknown) {
      // Invalidate the generation on every failed refresh. The request may
      // still settle later, and stale response cookies must not resurrect auth.
      this.store.invalidateSensitiveCookies?.();
      if (!this.store.invalidateSensitiveCookies) this.removeNamed("mdx_auth");
      throw error;
    }
  }

  private async scheduleRefresh(request: ReturnType<typeof buildRefreshRequest>) {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        reject(new Error("MadaraDex authentication refresh timed out."));
      }, this.refreshTimeoutMs);
    });
    try {
      return await Promise.race([
        scheduleRawResponse(request, AUTH_RESPONSE_OPTIONS),
        timeoutPromise,
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }
}
