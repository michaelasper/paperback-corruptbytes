import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createContext, runInContext } from "node:vm";

import { verifyAtsumaruAssociations } from "./verify-atsumaru-associations.mjs";

// Deliberately no Buffer, atob, URL, fetch, process, require or browser globals.
// This models a cold JS runtime, not Paperback's native UI or database bridge.
export async function verifyRuntime(code, id, { state, atob } = {}) {
  const registrations = new Set();
  const context = createContext({
    ...(atob && { atob }),
    Application: {
      getState: () => state,
      getSecureState: () => state,
      setState: () => {},
      setSecureState: () => {},
      Selector: (owner, method) => {
        assert.equal(typeof owner[method], "function", `${id}: invalid selector ${method}`);
        return owner[method].bind(owner);
      },
      registerInterceptor: (name) => {
        assert.equal(registrations.has(name), false, `${id}: duplicate interceptor ${name}`);
        registrations.add(name);
      },
    },
  });
  runInContext(code, context, { timeout: 5_000, filename: `${id}/index.js` });
  assert.equal(typeof context.source?.[id]?.initialise, "function", `${id}: missing instance`);
  await runInContext(`source[${JSON.stringify(id)}].initialise()`, context, { timeout: 5_000 });
  assert.ok(registrations.size >= 2, `${id}: interceptors were not registered`);
  if (atob) assert.equal(context.atob, atob, `${id}: replaced host atob`);
  assert.equal(runInContext('atob("AP+AQQ==")', context), "\x00\xff\x80A");
  return { registrations: registrations.size };
}

export async function verifyBundledRuntime(root = process.cwd()) {
  const manifest = JSON.parse(await readFile(resolve(root, "bundles/versioning.json"), "utf8"));
  for (const { id } of manifest.sources) {
    const code = await readFile(resolve(root, "bundles", id, "index.js"), "utf8");
    await verifyRuntime(code, id);
    if (id === "Atsumaru") await verifyAtsumaruAssociations(code);
  }
  return manifest.sources.length;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    console.log(
      `Cold-started ${await verifyBundledRuntime()} Paperback source bundles without Node/browser globals. Verified Atsumaru chapter associations and recovered reader routing.`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
