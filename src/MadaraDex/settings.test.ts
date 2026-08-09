import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { Cookie } from "@paperback/types";

import type { MadaraCookieStore, MdxAuthContract } from "./auth.js";
import { MadaraDexSettingsForm } from "./settings.js";

const originalApplication = globalThis.Application;

class FakeAuth implements MdxAuthContract {
  authenticated = false;
  refreshes = 0;

  async ensureAuthenticated(): Promise<void> {
    this.authenticated = true;
  }

  async refresh(_force?: boolean): Promise<void> {
    this.refreshes += 1;
    this.authenticated = true;
  }

  isAuthenticated(): boolean {
    return this.authenticated;
  }
}

class MemoryStore implements MadaraCookieStore {
  cookies: Cookie[] = [];
  acceptances = 0;

  setCookie(cookie: Cookie): void {
    this.cookies.push(cookie);
  }

  deleteCookie(_cookie: Cookie): void {}

  acceptSensitiveCookies(): void {
    this.acceptances += 1;
  }
}

beforeEach(() => {
  Object.assign(globalThis, {
    Application: { Selector: (_form: unknown, method: string) => method },
  });
});

afterEach(() => Object.assign(globalThis, { Application: originalApplication }));

describe("MadaraDex settings", () => {
  it("explains automatic reader authorization without presenting a fake login flow", async () => {
    const auth = new FakeAuth();
    const store = new MemoryStore();
    const form = new MadaraDexSettingsForm(auth, store);
    const section = form.getSections()[0]!;
    const status = section.items[0] as { title?: string; value?: string };
    assert.equal(status.title, "Reader access");
    assert.match(status.value ?? "", /refresh automatically/i);
    assert.match(String(section.footer), /no account or login is required/i);

    await form.handleRefresh();
    assert.equal(auth.refreshes, 1);
    const refreshedSection = form.getSections()[0];
    const refreshedStatus = refreshedSection?.items[0] as { value?: string } | undefined;
    assert.match(refreshedStatus?.value ?? "", /ready/i);
  });

  it("accepts only through the scoped cookie store after manual WebView verification", async () => {
    const auth = new FakeAuth();
    const store = new MemoryStore();
    const form = new MadaraDexSettingsForm(auth, store);
    const received: Cookie[] = [
      { name: "cf_clearance", value: "ok", domain: ".madaradex.org", path: "/" },
      { name: "foreign", value: "no", domain: "example.com", path: "/" },
    ];
    await form.handleVerificationComplete(received);
    assert.equal(store.acceptances, 1);
    assert.deepEqual(store.cookies, [received[0]]);
    assert.equal(auth.refreshes, 1);
  });
});
