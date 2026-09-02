import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { Cookie, Request, Response } from "@paperback/types";

import { ACCOUNT_URL, REFRESH_URL, type QiMangaCookieStore } from "./auth.js";
import { QiMangaSettingsForm, getShowLockedChapters } from "./settings.js";

const originalApplication = globalThis.Application;
let state = new Map<string, unknown>();
let requests: Request[] = [];

class MemoryCookieStore implements QiMangaCookieStore {
  cookies: Cookie[] = [];
  invalidations = 0;
  acceptances = 0;
  sensitiveCookieGeneration = 0;

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
    this.sensitiveCookieGeneration += 1;
  }

  acceptAuthCookies(): void {
    this.acceptances += 1;
    this.sensitiveCookieGeneration += 1;
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

  it("ignores an older login verification after a newer login completes", async () => {
    let accountCalls = 0;
    let releaseOld!: () => void;
    let markOldStarted!: () => void;
    const oldGate = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    const oldStarted = new Promise<void>((resolve) => {
      markOldStarted = resolve;
    });
    Object.assign(Application, {
      scheduleRequest: async (request: Request): Promise<[Response, ArrayBuffer]> => {
        requests.push(request);
        accountCalls += 1;
        if (accountCalls === 1) {
          markOldStarted();
          await oldGate;
          return [{ url: request.url, status: 503, headers: {}, cookies: [] }, new ArrayBuffer(0)];
        }
        if (accountCalls === 2) {
          return [
            { url: request.url, status: 200, headers: {}, cookies: [] },
            new TextEncoder().encode('{"id":2,"displayName":"Account B"}').buffer,
          ];
        }
        throw new Error("A stale settings operation must not revalidate the newer session.");
      },
    });
    const store = new MemoryCookieStore();
    let invalidations = 0;
    const form = new QiMangaSettingsForm(store, { authenticated: false }, () => {
      invalidations += 1;
    });

    const older = form.handleLoginComplete([
      { name: "accessToken", value: "account-a", domain: ".qimanga.com", path: "/" },
    ]);
    await oldStarted;
    const newer = form.handleLoginComplete([
      { name: "accessToken", value: "account-b", domain: ".qimanga.com", path: "/" },
    ]);
    await newer;
    releaseOld();
    await older;

    assert.deepEqual(form.account, { authenticated: true, displayName: "Account B" });
    assert.deepEqual(
      store.cookies.map(({ value }) => value),
      ["account-b"],
    );
    assert.equal(store.invalidations, 2);
    assert.equal(store.acceptances, 2);
    assert.equal(invalidations, 1);
  });

  it("serializes asynchronous authentication across separate settings forms", async () => {
    let accountCalls = 0;
    let releaseOld!: () => void;
    let markOldStarted!: () => void;
    const oldGate = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    const oldStarted = new Promise<void>((resolve) => {
      markOldStarted = resolve;
    });
    Object.assign(Application, {
      scheduleRequest: async (request: Request): Promise<[Response, ArrayBuffer]> => {
        accountCalls += 1;
        if (accountCalls === 1) {
          markOldStarted();
          await oldGate;
          return [{ url: request.url, status: 503, headers: {}, cookies: [] }, new ArrayBuffer(0)];
        }
        return [
          { url: request.url, status: 200, headers: {}, cookies: [] },
          new TextEncoder().encode('{"id":2,"displayName":"Account B"}').buffer,
        ];
      },
    });
    const store = new MemoryCookieStore();
    let oldChanges = 0;
    let newChanges = 0;
    const oldForm = new QiMangaSettingsForm(store, { authenticated: false }, () => {
      oldChanges += 1;
    });
    const newForm = new QiMangaSettingsForm(store, { authenticated: false }, () => {
      newChanges += 1;
    });

    const older = oldForm.handleLoginComplete([
      { name: "accessToken", value: "account-a", domain: ".qimanga.com", path: "/" },
    ]);
    await oldStarted;
    await newForm.handleLoginComplete([
      { name: "accessToken", value: "account-b", domain: ".qimanga.com", path: "/" },
    ]);
    releaseOld();
    await older;

    assert.deepEqual(oldForm.account, { authenticated: false });
    assert.deepEqual(newForm.account, { authenticated: true, displayName: "Account B" });
    assert.deepEqual(
      store.cookies.map(({ value }) => value),
      ["account-b"],
    );
    assert.equal(oldChanges, 0);
    assert.equal(newChanges, 1);
  });

  it("does not let a stale cancellation overwrite a newer verified login", async () => {
    let accountCalls = 0;
    let releaseCancellation!: () => void;
    let markCancellationStarted!: () => void;
    const cancellationGate = new Promise<void>((resolve) => {
      releaseCancellation = resolve;
    });
    const cancellationStarted = new Promise<void>((resolve) => {
      markCancellationStarted = resolve;
    });
    Object.assign(Application, {
      scheduleRequest: async (request: Request): Promise<[Response, ArrayBuffer]> => {
        requests.push(request);
        accountCalls += 1;
        if (accountCalls === 1) {
          markCancellationStarted();
          await cancellationGate;
          return [{ url: request.url, status: 403, headers: {}, cookies: [] }, new ArrayBuffer(0)];
        }
        return [
          { url: request.url, status: 200, headers: {}, cookies: [] },
          new TextEncoder().encode('{"id":2,"displayName":"Account B"}').buffer,
        ];
      },
    });
    const store = new MemoryCookieStore();
    store.cookies = [
      { name: "accessToken", value: "account-a", domain: ".qimanga.com", path: "/" },
    ];
    let invalidations = 0;
    const form = new QiMangaSettingsForm(
      store,
      { authenticated: true, displayName: "Account A" },
      () => {
        invalidations += 1;
      },
    );

    const cancellation = form.handleLoginCancel();
    await cancellationStarted;
    const login = form.handleLoginComplete([
      { name: "accessToken", value: "account-b", domain: ".qimanga.com", path: "/" },
    ]);
    await login;
    releaseCancellation();
    await cancellation;

    assert.deepEqual(form.account, { authenticated: true, displayName: "Account B" });
    assert.deepEqual(
      store.cookies.map(({ value }) => value),
      ["account-b"],
    );
    assert.equal(store.invalidations, 1);
    assert.equal(store.acceptances, 1);
    assert.equal(invalidations, 1);
  });

  it("fails closed for imported login cookies during a transient verification failure", async () => {
    Object.assign(Application, {
      scheduleRequest: async (request: Request): Promise<[Response, ArrayBuffer]> => {
        requests.push(request);
        return [
          { url: request.url, status: 503, headers: {}, cookies: [] },
          new TextEncoder().encode('{"error":"unavailable"}').buffer,
        ];
      },
    });
    const store = new MemoryCookieStore();
    store.cookies = [{ name: "cf_clearance", value: "clear", domain: ".qimanga.com" }];
    let invalidations = 0;
    const form = new QiMangaSettingsForm(store, { authenticated: false }, () => {
      invalidations += 1;
    });

    await form.handleLoginComplete([
      { name: "accessToken", value: "new", domain: ".qimanga.com", path: "/" },
    ]);

    assert.deepEqual(form.account, { authenticated: false });
    assert.deepEqual(
      store.cookies.map((cookie) => cookie.name),
      ["cf_clearance"],
    );
    assert.equal(store.invalidations, 2);
    assert.equal(invalidations, 1);
  });

  it("clears imported login cookies after a definitively rejected refresh", async () => {
    Object.assign(Application, {
      scheduleRequest: async (request: Request): Promise<[Response, ArrayBuffer]> => {
        requests.push(request);
        return [
          { url: request.url, status: 401, headers: {}, cookies: [] },
          new TextEncoder().encode('{"error":"unauthorized"}').buffer,
        ];
      },
    });
    const store = new MemoryCookieStore();
    store.cookies = [{ name: "cf_clearance", value: "clear", domain: ".qimanga.com" }];
    let invalidations = 0;
    const form = new QiMangaSettingsForm(store, { authenticated: false }, () => {
      invalidations += 1;
    });

    await form.handleLoginComplete([
      { name: "accessToken", value: "new", domain: ".qimanga.com", path: "/" },
    ]);

    assert.deepEqual(form.account, { authenticated: false });
    assert.deepEqual(
      store.cookies.map((cookie) => cookie.name),
      ["cf_clearance"],
    );
    assert.equal(store.invalidations, 3);
    assert.equal(invalidations, 1);
    assert.deepEqual(
      requests.map((request) => request.url),
      [ACCOUNT_URL, REFRESH_URL],
    );
  });

  it("invalidates account state after a cancelled login and exposes stale-session clearing", async () => {
    const store = new MemoryCookieStore();
    store.cookies = [{ name: "accessToken", value: "existing", domain: ".qimanga.com", path: "/" }];
    let invalidations = 0;
    const form = new QiMangaSettingsForm(store, { authenticated: false }, () => {
      invalidations += 1;
    });
    const logout = form.getSections()[0]?.items[2] as { isHidden?: boolean } | undefined;
    assert.equal(logout?.isHidden, false);

    await form.handleLoginCancel();

    assert.deepEqual(form.account, { authenticated: true, displayName: "Reader" });
    assert.equal(invalidations, 1);
  });

  it("fails closed when a cancelled login cannot be verified", async () => {
    Object.assign(Application, {
      scheduleRequest: async (request: Request): Promise<[Response, ArrayBuffer]> => {
        requests.push(request);
        return [
          { url: request.url, status: 503, headers: {}, cookies: [] },
          new TextEncoder().encode('{"error":"unavailable"}').buffer,
        ];
      },
    });
    const store = new MemoryCookieStore();
    store.cookies = [
      { name: "accessToken", value: "unverified", domain: ".qimanga.com", path: "/" },
      { name: "cf_clearance", value: "clear", domain: ".qimanga.com", path: "/" },
    ];
    let invalidations = 0;
    const form = new QiMangaSettingsForm(store, { authenticated: false }, () => {
      invalidations += 1;
    });

    await form.handleLoginCancel();

    assert.deepEqual(form.account, { authenticated: false });
    assert.deepEqual(
      store.cookies.map((cookie) => cookie.name),
      ["cf_clearance"],
    );
    assert.equal(store.invalidations, 1);
    assert.equal(invalidations, 1);
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
