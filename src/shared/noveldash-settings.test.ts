import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import type {
  Cookie,
  FormItemElement,
  FormSectionElement,
  Request,
  Response,
} from "@paperback/types";

import type { NovelDashCookieStore } from "./noveldash-auth.js";
import { getNovelDashShowLockedChapters, NovelDashSettingsForm } from "./noveldash-settings.js";
import { NOVELDASH_TEST_SITE } from "./noveldash-test-fixtures.js";

const originalApplication = globalThis.Application;
let state = new Map<string, unknown>();

class MemoryStore implements NovelDashCookieStore {
  cookies: Cookie[] = [];
  acceptances = 0;
  invalidations = 0;

  setCookie(cookie: Cookie): void {
    this.cookies = this.cookies.filter(
      (candidate) => candidate.name !== cookie.name || candidate.domain !== cookie.domain,
    );
    this.cookies.push(cookie);
  }

  deleteCookie(cookie: Cookie): void {
    this.cookies = this.cookies.filter((candidate) => candidate !== cookie);
  }

  invalidateSensitiveCookies(): void {
    this.invalidations += 1;
  }

  acceptSensitiveCookies(): void {
    this.acceptances += 1;
  }
}

const session = (overrides: Partial<Cookie> = {}): Cookie => ({
  name: "__Secure-authjs.session-token",
  value: "session",
  domain: ".fixture.example",
  path: "/",
  ...overrides,
});

const item = <T>(sections: FormSectionElement<unknown>[], id: string): T => {
  const found = sections
    .flatMap((section) => section.items)
    .find((candidate) => candidate.id === id);
  assert.ok(found, `Missing form item ${id}.`);
  return found as FormItemElement<unknown> as T;
};

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
        new TextEncoder().encode(JSON.stringify({ user: { id: "reader", name: "Fixture Reader" } }))
          .buffer,
      ],
    },
  });
});

afterEach(() => {
  Object.assign(globalThis, { Application: originalApplication });
});

describe("NovelDash settings", () => {
  it("shows locked chapters by default and persists the preference", async () => {
    assert.equal(getNovelDashShowLockedChapters(NOVELDASH_TEST_SITE), true);
    const form = new NovelDashSettingsForm(NOVELDASH_TEST_SITE, new MemoryStore(), {
      authenticated: false,
    });

    await form.handleShowLockedChange(false);
    assert.equal(getNovelDashShowLockedChapters(NOVELDASH_TEST_SITE), false);
  });

  it("uses the first-party login page and explains paid access", () => {
    const form = new NovelDashSettingsForm(NOVELDASH_TEST_SITE, new MemoryStore(), {
      authenticated: false,
    });
    const sections = form.getSections();
    const login = item<{ request: Request; title: string; type: string }>(sections, "login");
    const clear = item<{ isHidden: boolean }>(sections, "clear_session");

    assert.equal(login.type, "webViewRow");
    assert.equal(login.title, "Sign in to Fixture Scans");
    assert.deepEqual(login.request, { url: "https://fixture.example/login", method: "GET" });
    assert.equal(clear.isHidden, true);
    assert.match(sections[1]?.footer ?? "", /never purchases or bypasses/i);
  });

  it("replaces source auth cookies, validates the session, and clears only authentication", async () => {
    const store = new MemoryStore();
    const clearance = session({ name: "cf_clearance", value: "clear" });
    store.cookies = [session({ value: "old" }), clearance];
    let changes = 0;
    const form = new NovelDashSettingsForm(
      NOVELDASH_TEST_SITE,
      store,
      { authenticated: false },
      () => (changes += 1),
    );

    await form.handleLoginComplete([
      session({ value: "new" }),
      session({ name: "foreign", domain: "evil.example" }),
    ]);

    assert.deepEqual(form.account, { authenticated: true, displayName: "Fixture Reader" });
    assert.deepEqual(store.cookies, [clearance, session({ value: "new" })]);
    assert.equal(store.invalidations, 1);
    assert.equal(store.acceptances, 1);
    assert.equal(changes, 1);

    await form.handleClearSession();
    assert.deepEqual(form.account, { authenticated: false });
    assert.deepEqual(store.cookies, [clearance]);
    assert.equal(changes, 2);
  });
});
