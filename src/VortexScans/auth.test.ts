import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import type { Cookie, Request, Response } from "@paperback/types";

import {
  clearVortexCookies,
  fetchAccountStatus,
  isVortexCookie,
  persistVortexCookies,
  signOut,
  type CookieStore,
} from "./auth.js";

const originalApplication = globalThis.Application;

const cookie = (overrides: Partial<Cookie> = {}): Cookie => ({
  name: "__Secure-vthemeauth.session_token",
  value: "secret",
  domain: ".vortexscans.org",
  path: "/",
  expires: new Date(Date.now() + 60_000),
  ...overrides,
});

class MemoryCookieStore implements CookieStore {
  cookies: Cookie[] = [];
  invalidations = 0;
  acceptances = 0;

  invalidateAuthCookies(): void {
    this.invalidations += 1;
  }

  acceptAuthCookies(): void {
    this.acceptances += 1;
  }

  setCookie(value: Cookie): void {
    this.cookies.push(value);
  }

  deleteCookie(value: Cookie): void {
    this.cookies = this.cookies.filter(
      (candidate) =>
        candidate.name !== value.name ||
        candidate.domain !== value.domain ||
        (candidate.path ?? "/") !== (value.path ?? "/"),
    );
  }
}

const installApplication = (
  status: number,
  body: string,
): { requests: Request[]; setResponse(status: number, body: string): void } => {
  const requests: Request[] = [];
  let currentStatus = status;
  let currentBody = body;
  Object.assign(globalThis, {
    Application: {
      arrayBufferToUTF8String: (buffer: ArrayBuffer) => new TextDecoder().decode(buffer),
      scheduleRequest: async (request: Request): Promise<[Response, ArrayBuffer]> => {
        requests.push(request);
        return [
          { url: request.url, status: currentStatus, headers: {}, cookies: [] } as Response,
          new TextEncoder().encode(currentBody).buffer,
        ];
      },
    },
  });

  return {
    requests,
    setResponse(nextStatus, nextBody) {
      currentStatus = nextStatus;
      currentBody = nextBody;
    },
  };
};

afterEach(() => {
  Object.assign(globalThis, { Application: originalApplication });
});

describe("Vortex cookie handling", () => {
  it("recognizes only first-party Vortex cookies", () => {
    assert.equal(isVortexCookie(cookie()), true);
    assert.equal(isVortexCookie(cookie({ domain: ".vortexscans.org" })), true);
    assert.equal(isVortexCookie(cookie({ domain: "dashboard.vortexscans.org" })), true);
    assert.equal(isVortexCookie(cookie({ domain: "www.vortexscans.org" })), false);
    assert.equal(isVortexCookie(cookie({ domain: "notvortexscans.org" })), false);
    assert.equal(isVortexCookie(cookie({ domain: "challenges.cloudflare.com" })), false);
  });

  it("persists unexpired first-party cookies and ignores third-party or expired cookies", () => {
    const store = new MemoryCookieStore();
    const accepted = cookie();
    store.cookies = [cookie({ name: "stale" })];
    persistVortexCookies(store, [
      accepted,
      cookie({ name: "stale", expires: new Date(Date.now() - 1) }),
      cookie({ name: "third-party", domain: "google.com" }),
    ]);

    assert.deepEqual(store.cookies, [accepted]);
  });

  it("clears Vortex auth cookies without discarding Cloudflare clearance", () => {
    const store = new MemoryCookieStore();
    const unrelated = cookie({ domain: "example.com" });
    const clearance = cookie({ name: "cf_clearance", domain: ".vortexscans.org" });
    store.cookies = [
      cookie(),
      cookie({ name: "vthemeauth.session_hint" }),
      cookie({ name: "__Host-better-auth.session_token" }),
      clearance,
      unrelated,
    ];

    clearVortexCookies(store);

    assert.deepEqual(store.cookies, [clearance, unrelated]);
  });
});

describe("Vortex account status", () => {
  it("validates the authenticated account through /api/me", async () => {
    const application = installApplication(
      200,
      JSON.stringify({
        user: { id: "42", name: "Reader", email: "reader@example.com" },
        session: { id: "session" },
        hasSessionCookie: true,
      }),
    );

    assert.deepEqual(await fetchAccountStatus(), {
      authenticated: true,
      displayName: "Reader",
      email: "reader@example.com",
    });
    assert.deepEqual(application.requests, [
      { url: "https://api.vortexscans.org/api/me", method: "GET" },
    ]);
  });

  it("treats missing, rejected, and malformed sessions as logged out", async () => {
    const application = installApplication(401, '{"message":"Unauthorized"}');
    const store = new MemoryCookieStore();
    store.cookies = [cookie()];
    assert.deepEqual(await fetchAccountStatus(store), { authenticated: false });
    assert.deepEqual(store.cookies, []);
    assert.equal(store.invalidations, 1);

    application.setResponse(200, "{}");
    assert.deepEqual(await fetchAccountStatus(), { authenticated: false });

    store.cookies = [cookie()];
    application.setResponse(
      200,
      JSON.stringify({ user: null, session: null, hasSessionCookie: false }),
    );
    assert.deepEqual(await fetchAccountStatus(store), { authenticated: false });
    assert.deepEqual(store.cookies, []);

    application.setResponse(200, "not-json");
    assert.deepEqual(await fetchAccountStatus(), { authenticated: false });
  });

  it("accepts a validated Better Auth session even when profile fields are absent", async () => {
    installApplication(
      200,
      JSON.stringify({ user: null, session: { id: "session" }, hasSessionCookie: true }),
    );

    assert.deepEqual(await fetchAccountStatus(), { authenticated: true });

    installApplication(200, JSON.stringify({ user: null, session: {}, hasSessionCookie: true }));
    assert.deepEqual(await fetchAccountStatus(), { authenticated: false });
  });

  it("signs out server-side and always clears the local session", async () => {
    const application = installApplication(500, "failed");
    const store = new MemoryCookieStore();
    store.cookies = [cookie()];

    await signOut(store);

    assert.equal(store.cookies.length, 0);
    assert.equal(store.invalidations, 1);
    assert.deepEqual(application.requests, [
      {
        url: "https://api.vortexscans.org/api/auth/sign-out",
        method: "POST",
        cookies: { "__Secure-vthemeauth.session_token": "secret" },
      },
    ]);
  });
});
