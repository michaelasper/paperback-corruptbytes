import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { Cookie, Request, Response } from "@paperback/types";

import type { QiMangaCookieStore } from "./auth.js";
import { QiMangaSettingsForm, getShowLockedChapters } from "./settings.js";

const originalApplication = globalThis.Application;
let state = new Map<string, unknown>();
let requests: Request[] = [];

class MemoryCookieStore implements QiMangaCookieStore {
  cookies: Cookie[] = [];
  invalidations = 0;
  acceptances = 0;

  setCookie(cookie: Cookie): void {
    this.cookies.push(cookie);
  }

  deleteCookie(cookie: Cookie): void {
    this.cookies = this.cookies.filter(
      (candidate) => candidate.name !== cookie.name || candidate.domain !== cookie.domain,
    );
  }

  invalidateAuthCookies(): void {
    this.invalidations += 1;
  }

  acceptAuthCookies(): void {
    this.acceptances += 1;
  }
}

beforeEach(() => {
  state = new Map();
  requests = [];
  Object.assign(globalThis, {
    Application: {
      Selector: (_form: unknown, method: string) => method,
      getState: (key: string) => state.get(key),
      setState: (value: unknown, key: string) => state.set(key, value),
      arrayBufferToUTF8String: (buffer: ArrayBuffer) => new TextDecoder().decode(buffer),
      scheduleRequest: async (request: Request): Promise<[Response, ArrayBuffer]> => {
        requests.push(request);
        return [
          { url: request.url, status: 200, headers: {}, cookies: [] },
          new TextEncoder().encode('{"id":42,"displayName":"Reader"}').buffer,
        ];
      },
    },
  });
});

afterEach(() => Object.assign(globalThis, { Application: originalApplication }));

describe("Qi Manga settings", () => {
  it("shows locked chapters by default and persists explicit changes", async () => {
    assert.equal(getShowLockedChapters(), true);
    const form = new QiMangaSettingsForm(new MemoryCookieStore(), { authenticated: false });
    await form.handleShowLockedChange(false);
    assert.equal(getShowLockedChapters(), false);
    assert.equal(state.get("qi_manga.show_locked_chapters"), false);
  });

  it("describes first-party sign-in and paywall behavior honestly", () => {
    const sections = new QiMangaSettingsForm(new MemoryCookieStore(), {
      authenticated: true,
      displayName: "Reader",
    }).getSections();
    const account = sections[0];
    const chapters = sections[1];
    assert.ok(account);
    assert.ok(chapters);
    assert.match(String(account.footer), /credentials stay.*WebView/i);
    assert.match(String(account.footer), /already purchased/i);
    assert.equal((account.items[0] as { value?: string }).value, "Logged in as Reader");
    assert.match(String(chapters.footer), /never purchases or unlocks/i);
    assert.match(
      (chapters.items[0] as { subtitle?: string }).subtitle ?? "",
      /unavailable.*coin price/i,
    );
  });

  it("replaces login cookies, verifies the account, and invalidates chapter state", async () => {
    const store = new MemoryCookieStore();
    store.cookies = [
      { name: "oldSession", value: "old", domain: ".qimanga.com", path: "/" },
      { name: "cf_clearance", value: "clear", domain: ".qimanga.com", path: "/" },
    ];
    let invalidations = 0;
    const form = new QiMangaSettingsForm(store, { authenticated: false }, () => {
      invalidations += 1;
    });
    await form.handleLoginComplete([
      { name: "accessToken", value: "new", domain: ".qimanga.com", path: "/" },
      { name: "evil", value: "no", domain: "example.com", path: "/" },
    ]);

    assert.deepEqual(form.account, { authenticated: true, displayName: "Reader" });
    assert.equal(invalidations, 1);
    assert.equal(store.invalidations, 1);
    assert.equal(store.acceptances, 1);
    assert.deepEqual(
      store.cookies.map((cookie) => cookie.name),
      ["cf_clearance", "accessToken"],
    );
    assert.equal(
      requests.some((request) => request.url.endsWith("/users/me")),
      true,
    );
  });

  it("clears local and remote sessions on logout", async () => {
    const store = new MemoryCookieStore();
    store.cookies = [
      { name: "accessToken", value: "secret", domain: ".qimanga.com", path: "/" },
      { name: "cf_clearance", value: "clear", domain: ".qimanga.com", path: "/" },
    ];
    let invalidations = 0;
    const form = new QiMangaSettingsForm(
      store,
      { authenticated: true, displayName: "Reader" },
      () => {
        invalidations += 1;
      },
    );

    await form.handleLogout();

    assert.deepEqual(form.account, { authenticated: false });
    assert.deepEqual(
      store.cookies.map((cookie) => cookie.name),
      ["cf_clearance"],
    );
    assert.equal(invalidations, 1);
    assert.equal(
      requests.some((request) => request.url.endsWith("/auth/logout")),
      true,
    );
  });
});
