import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { MgekoSettingsForm, getSafeMode } from "./settings.js";

const originalApplication = globalThis.Application;
let state = new Map<string, unknown>();

beforeEach(() => {
  state = new Map();
  Object.assign(globalThis, {
    Application: {
      Selector: (_form: unknown, method: string) => method,
      getState: (key: string) => state.get(key),
      setState: (value: unknown, key: string) => state.set(key, value),
    },
  });
});

afterEach(() => Object.assign(globalThis, { Application: originalApplication }));

describe("Mgeko settings", () => {
  it("defaults to safe mode and remains compatible with the prior extension state key", async () => {
    assert.equal(getSafeMode(), true);
    const form = new MgekoSettingsForm();
    await form.handleSafeModeChange(false);
    assert.equal(getSafeMode(), false);
    assert.equal(state.get("safe_mode"), false);
  });

  it("describes safe mode honestly without claiming title details are inaccessible", () => {
    const section = new MgekoSettingsForm().getSections()[0];
    const toggle = section?.items[0] as { title?: string; subtitle?: string; value?: boolean };
    assert.equal(toggle.title, "Safe mode");
    assert.match(toggle.subtitle ?? "", /hide adult.*discover.*search/i);
    assert.equal(toggle.value, true);
  });
});
