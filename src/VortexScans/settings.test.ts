import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import type {
  Cookie,
  FormItemElement,
  FormSectionElement,
  Request,
  Response,
} from "@paperback/types";

import type { CookieStore } from "./auth.js";
import { getShowLockedChapters, VortexSettingsForm } from "./settings.js";

const originalApplication = globalThis.Application;

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

  setCookie(cookie: Cookie): void {
    this.cookies.push(cookie);
  }

  deleteCookie(cookie: Cookie): void {
    this.cookies = this.cookies.filter((candidate) => candidate !== cookie);
  }
}

const futureCookie = (): Cookie => ({
  name: "__Secure-vthemeauth.session_token",
  value: "token",
  domain: ".vortexscans.org",
  path: "/",
  expires: new Date(Date.now() + 60_000),
});

const item = <T>(sections: FormSectionElement<unknown>[], id: string): T => {
  const found = sections
    .flatMap((section) => section.items)
    .find((candidate) => candidate.id === id);
  assert.ok(found, `Missing form item ${id}`);
  return found as FormItemElement<unknown> as T;
};

let state = new Map<string, unknown>();
let requests: Request[] = [];

beforeEach(() => {
  state = new Map();
  requests = [];
  Object.assign(globalThis, {
    Application: {
      Selector: () => "selector",
      arrayBufferToUTF8String: (buffer: ArrayBuffer) => new TextDecoder().decode(buffer),
      formDidChange: () => undefined,
      getState: (key: string) => state.get(key),
      setState: (value: unknown, key: string) => state.set(key, value),
      scheduleRequest: async (request: Request): Promise<[Response, ArrayBuffer]> => {
        requests.push(request);
        return [
          { url: request.url, status: 200, headers: {}, cookies: [] } as Response,
          new TextEncoder().encode(
            JSON.stringify({
              user: { id: "42", name: "Reader", email: "reader@example.com" },
              session: { id: "session" },
            }),
          ).buffer,
        ];
      },
    },
  });
});

afterEach(() => {
  Object.assign(globalThis, { Application: originalApplication });
});

describe("Vortex settings", () => {
  it("shows locked chapters by default and persists the user's choice", async () => {
    assert.equal(getShowLockedChapters(), true);

    const form = new VortexSettingsForm(new MemoryCookieStore(), { authenticated: false });
    await form.handleShowLockedChange(false);

    assert.equal(getShowLockedChapters(), false);
  });

  it("uses the real sign-in page so social login remains available", () => {
    const form = new VortexSettingsForm(new MemoryCookieStore(), { authenticated: false });
    const sections = form.getSections();
    const login = item<{
      request: Request;
      title: string;
      type: string;
    }>(sections, "login");
    const logout = item<{ isHidden: boolean }>(sections, "logout");
    const locked = item<{ value: boolean }>(sections, "show_locked");

    assert.equal(login.type, "webViewRow");
    assert.equal(login.title, "Sign in to Vortex Scans");
    assert.deepEqual(login.request, {
      url: "https://vortexscans.org/auth/signin",
      method: "GET",
    });
    assert.equal(logout.isHidden, true);
    assert.equal(locked.value, true);
  });

  it("captures only Vortex cookies and refreshes the validated account status", async () => {
    const store = new MemoryCookieStore();
    store.cookies = [
      {
        ...futureCookie(),
        value: "old-account-token",
        domain: "api.vortexscans.org",
      },
    ];
    const form = new VortexSettingsForm(store, { authenticated: false });

    await form.handleLoginComplete([
      futureCookie(),
      { ...futureCookie(), name: "third_party", domain: "google.com" },
    ]);

    assert.equal(store.cookies.length, 1);
    assert.equal(store.cookies[0]?.value, "token");
    assert.equal(store.cookies[0]?.domain, ".vortexscans.org");
    assert.equal(store.invalidations, 1);
    assert.equal(store.acceptances, 1);
    assert.deepEqual(form.account, {
      authenticated: true,
      displayName: "Reader",
      email: "reader@example.com",
    });
    assert.deepEqual(requests, [{ url: "https://api.vortexscans.org/api/me", method: "GET" }]);
  });

  it("logs out remotely and hides the logout action", async () => {
    const store = new MemoryCookieStore();
    store.cookies = [futureCookie()];
    const form = new VortexSettingsForm(store, {
      authenticated: true,
      displayName: "Reader",
    });

    await form.handleLogout();

    assert.deepEqual(store.cookies, []);
    assert.deepEqual(form.account, { authenticated: false });
    assert.equal(item<{ isHidden: boolean }>(form.getSections(), "logout").isHidden, true);
    assert.deepEqual(requests, [
      {
        url: "https://api.vortexscans.org/api/auth/sign-out",
        method: "POST",
        cookies: { "__Secure-vthemeauth.session_token": "token" },
      },
    ]);
  });
});
