import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";

import { SourceIntents } from "@paperback/types";

const sources = (await readdir(new URL("../src/", import.meta.url))).filter(
  (entry) => entry !== "shared" && !entry.startsWith("."),
);

void test("every source metadata declares a valid extension id and version", async () => {
  assert.ok(sources.length > 0);
  for (const id of sources) {
    const config = (await import(`../src/${id}/pbconfig.js`)).default;
    assert.equal(typeof config.name, "string", `${id} needs a name`);
    assert.match(config.version ?? "", /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/, `${id} needs semver`);
    assert.equal(config.icon, "icon.png", `${id} needs an icon`);
    assert.ok(
      Array.isArray(config.capabilities) && config.capabilities.length > 0,
      `${id} needs capabilities`,
    );
  }
});

void test("every source entry point exports an instance named after its directory", async () => {
  for (const id of sources) {
    const main = await readFile(new URL(`../src/${id}/main.ts`, import.meta.url), "utf8");
    assert.match(
      main,
      new RegExp(`export\\s+const\\s+${id}\\s*=`),
      `${id}/main.ts must export an instance named ${id} for the Paperback runtime lookup`,
    );
  }
});

void test("cloudflare bypass sources always ship a settings form", async () => {
  for (const id of sources) {
    const config = (await import(`../src/${id}/pbconfig.js`)).default;
    const capabilities = new Set(config.capabilities);
    if (capabilities.has(SourceIntents.CLOUDFLARE_BYPASS_PROVIDING)) {
      assert.ok(
        capabilities.has(SourceIntents.SETTINGS_FORM_PROVIDING),
        `${id} declares Cloudflare bypass without a settings form, which Paperback rejects as invalid`,
      );
    }
  }
});
