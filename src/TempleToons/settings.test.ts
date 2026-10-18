import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { FormItemElement, FormSectionElement } from "@paperback/types";

import { getShowLockedChapters, TempleSettingsForm } from "./settings.js";

const originalApplication = globalThis.Application;

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
      formDidChange: () => undefined,
      getState: (key: string) => state.get(key),
      setState: (value: unknown, key: string) => state.set(key, value),
    },
  });
});

afterEach(() => {
  Object.assign(globalThis, { Application: originalApplication });
});

describe("Temple settings", () => {
  it("shows locked chapters by default and persists the choice", async () => {
    assert.equal(getShowLockedChapters(), true);
    state.set("temple_scan.show_locked_chapters", "false");
    assert.equal(getShowLockedChapters(), true);
    const form = new TempleSettingsForm();

    await form.handleShowLockedChange(false);

    assert.equal(getShowLockedChapters(), false);
    assert.equal(state.get("temple_scan.show_locked_chapters"), false);
  });

  it("renders the locked chapter toggle with the stored preference", () => {
    const form = new TempleSettingsForm();
    assert.equal(item<{ value: boolean }>(form.getSections(), "show_locked").value, true);

    state.set("temple_scan.show_locked_chapters", false);
    const toggle = item<{ title: string; value: boolean }>(form.getSections(), "show_locked");

    assert.equal(toggle.title, "Show locked premium chapters");
    assert.equal(toggle.value, false);
  });
});
