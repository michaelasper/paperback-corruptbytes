import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";

import { build } from "rolldown";

import { createDeterministicRandom, deriveDeterministicSeed } from "./random-runtime.ts";
import { verifyAtsumaruAssociations } from "./verify-atsumaru-associations.mjs";
import { verifyRuntime } from "./verify-runtime.mjs";

const sourceRoot = new URL("../src/", import.meta.url);
const sources = (await readdir(sourceRoot)).filter((id) => id !== "shared" && !id.startsWith("."));

void test("every bundled source cold-starts with randomized persisted state and no Node globals", async (t) => {
  for (const id of sources) {
    await t.test(id, async () => {
      const result = await build({
        input: new URL(`${id}/main.ts`, sourceRoot).pathname,
        transform: { target: "es2020" },
        output: { format: "iife", name: "source", minify: true },
        write: false,
      });
      const code = result.output[0].code;
      const seed = deriveDeterministicSeed(0x1_00_00, id);
      const random = createDeterministicRandom(seed);
      const states = [undefined, null, false, 42, "invalid", {}, [], [{ name: null }]];
      for (let iteration = 0; iteration < 20; iteration += 1) {
        const state =
          iteration < states.length
            ? states[iteration]
            : Array.from({ length: random.integer(1, 25) }, () => ({
                name: random.pick(["session", "cf_clearance", "", null]),
                value: random.pick(["stale", "", 23]),
                domain: random.pick(["untrusted.invalid", ".invalid", null]),
                expires: random.pick(["invalid", 0, "2000-01-01T00:00:00Z"]),
              }));
        try {
          await verifyRuntime(code, id, { state });
        } catch (error) {
          throw new Error(`${id}: seed=${seed} iteration=${iteration}`, { cause: error });
        }
      }
      await verifyRuntime(code, id, { atob: globalThis.atob });
      // Mutation-sensitive proof that the harness catches the original failure.
      await assert.rejects(
        verifyRuntime(`Buffer.from("AA==", "base64");\n${code}`, id),
        /Buffer is not defined/,
      );
    });
  }
});

void test("the freshly compiled Atsumaru export preserves app associations and recovered reader routing", async () => {
  const result = await build({
    input: new URL("Atsumaru/main.ts", sourceRoot).pathname,
    transform: { target: "es2020" },
    output: { format: "iife", name: "source", minify: true },
    write: false,
  });
  await verifyAtsumaruAssociations(result.output[0].code);
});

void test("production HTML imports cannot bypass the runtime bootstrap", async () => {
  for (const id of [...sources, "shared"]) {
    for (const name of await readdir(new URL(`${id}/`, sourceRoot))) {
      if (!name.endsWith(".ts") || name.endsWith(".test.ts") || name === "html-parser.ts") continue;
      const text = await readFile(new URL(`${id}/${name}`, sourceRoot), "utf8");
      assert.doesNotMatch(text, /import\s+(?!type\b)[^;]*from\s+["']cheerio["']/, `${id}/${name}`);
    }
  }
});
