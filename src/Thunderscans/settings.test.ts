import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import type {
  Cookie,
  FormItemElement,
  FormSectionElement,
  Request,
  Response,
} from "@paperback/types";

import type { ThunderCookieStore } from "./auth.js";
import { getShowLockedChapters, ThunderSettingsForm } from "./settings.js";

const originalApplication = globalThis.Application;

class MemoryStore implements ThunderCookieStore {
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
    this.cookies = this.cookies.filter((candidate) => candidate.name !== cookie.name);
    this.cookies.push(cookie);
  }

  deleteCookie(cookie: Cookie): void {
    this.cookies = this.cookies.filter((candidate) => candidate !== cookie);
  }
}

const session = (overrides: Partial<Cookie> = {}): Cookie => ({
  name: "PHPSESSID",
  value: "session",
  domain: "en-thunderscans.com",
  path: "/",
  ...overrides,
});

const item = <T>(sections: FormSectionElement<unknown>[], id: string): T => {
  const found = sections
    .flatMap((section) => section.items)
    .find((candidate) => candidate.id === id);
  assert.ok(found, `Missing form item ${id}`);
  return found as FormItemElement<unknown> as T;
};

let state = new Map<string, unknown>();

beforeEach(() => {
  state = new Map();
  Object.assign(globalThis, {
    Application: {
      Selector: () => "selector",
      arrayBufferToUTF8String: (buffer: ArrayBuffer) => new TextDecoder().decode(buffer),
      formDidChange: () => undefined,
      getState: (key: string) => state.get(key),
      setState: (value: unknown, key: string) => state.set(key, value),
      scheduleRequest: async (request: Request): Promise<[Response, ArrayBuffer]> => [
        { url: request.url, status: 200, headers: {}, cookies: [] },
        new TextEncoder().encode('<h1 class="profile-name">Reader</h1>').buffer,
      ],
    },
  });
});

afterEach(() => {
  Object.assign(globalThis, { Application: originalApplication });
});

describe("Thunder settings", () => {
  it("shows locked chapters by default and persists the choice", async () => {
    assert.equal(getShowLockedChapters(), true);
    const form = new ThunderSettingsForm(new MemoryStore(), { authenticated: false });

    await form.handleShowLockedChange(false);
    assert.equal(getShowLockedChapters(), false);
  });

  it("uses Thunder's first-party login page and explains purchased chapters", () => {
    const form = new ThunderSettingsForm(new MemoryStore(), { authenticated: false });
    const sections = form.getSections();
    const login = item<{ request: Request; title: string; type: string }>(sections, "login");
    const logout = item<{ isHidden: boolean }>(sections, "logout");

    assert.equal(login.type, "webViewRow");
    assert.equal(login.title, "Sign in to Thunder Scans");
    assert.deepEqual(login.request, {
      url: "https://en-thunderscans.com/login/",
      method: "GET",
    });
    assert.equal(logout.isHidden, true);
    assert.match(sections[1]?.footer ?? "", /purchased/i);
  });

  it("replaces captured cookies, validates /profile/, and invalidates reader caches", async () => {
    const store = new MemoryStore();
    store.cookies = [session({ value: "old" })];
    let invalidations = 0;
    const form = new ThunderSettingsForm(
      store,
      { authenticated: false },
      () => (invalidations += 1),
    );

    await form.handleLoginComplete([
      session({ value: "new" }),
      session({ name: "foreign", domain: "google.com" }),
    ]);

    assert.deepEqual(store.cookies, [session({ value: "new" })]);
    assert.deepEqual(form.account, { authenticated: true, displayName: "Reader" });
    assert.equal(store.invalidations, 1);
    assert.equal(store.acceptances, 1);
    assert.equal(invalidations, 1);
  });

  it("clears local authentication but retains Cloudflare cookies", async () => {
    const store = new MemoryStore();
    const clearance = session({ name: "cf_clearance", value: "clear" });
    store.cookies = [session(), clearance];
    let invalidations = 0;
    const form = new ThunderSettingsForm(
      store,
      { authenticated: true, displayName: "Reader" },
      () => (invalidations += 1),
    );

    await form.handleLogout();

    assert.deepEqual(store.cookies, [clearance]);
    assert.deepEqual(form.account, { authenticated: false });
    assert.equal(invalidations, 1);
    assert.equal(item<{ isHidden: boolean }>(form.getSections(), "logout").isHidden, true);
  });
});
