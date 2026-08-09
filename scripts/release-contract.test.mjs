import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import { pinSafeDirectory, readSafeFile } from "./safe-files.mjs";
import { verifyBundles } from "./verify-bundles.mjs";
import { verifyVersionBumps } from "./verify-version-bumps.mjs";
import {
  PB_CONFIG_MAX_BYTES,
  compareSemver,
  extractExtensionInfo,
  extractVersion,
  isValidSemver,
} from "./version-utils.mjs";

const execFileAsync = promisify(execFile);

async function runGit(root, args) {
  const { stdout } = await execFileAsync("git", args, { cwd: root, encoding: "utf8" });
  return stdout.trim();
}

async function temporaryDirectory() {
  return mkdtemp(join(tmpdir(), "paperback-release-contract-"));
}

async function writeSource(root, id, version, files = {}) {
  const directory = join(root, "src", id);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "pbconfig.ts"),
    `export default { name: "${id}", version: "${version}", icon: "icon.png" };\n`,
  );
  for (const [path, content] of Object.entries(files)) {
    const filePath = join(directory, path);
    await mkdir(join(filePath, ".."), { recursive: true });
    await writeFile(filePath, content);
  }
}

async function gitFixture(sources = { Alpha: "1.0.0-alpha.1" }) {
  const root = await temporaryDirectory();
  for (const [id, version] of Object.entries(sources)) {
    await writeSource(root, id, version, { "main.ts": "export default {};\n" });
  }
  await runGit(root, ["init", "-b", "main"]);
  await runGit(root, ["config", "user.email", "release-tests@example.invalid"]);
  await runGit(root, ["config", "user.name", "Release Contract Tests"]);
  await runGit(root, ["add", "."]);
  await runGit(root, ["commit", "-m", "baseline"]);
  const base = await runGit(root, ["rev-parse", "HEAD"]);
  return { root, base };
}

async function releaseFixture(sources = { Alpha: "1.0.0-alpha.1" }) {
  const fixture = await gitFixture(sources);
  return fixture;
}

async function bundleFixture({
  sourceIds = ["Alpha"],
  sourceVersion = "1.0.0-alpha.1",
  sourceDescription = "Current description",
  icon = "icon.png",
  infoOverrides = {},
  listedOverrides = {},
  addOrphan = false,
  symlinkIcon = false,
} = {}) {
  const root = await temporaryDirectory();
  await mkdir(join(root, "bundles"), { recursive: true });
  await writeFile(join(root, "bundles", "index.html"), "<!doctype html>\n");
  const listedSources = [];
  for (const id of sourceIds) {
    const sourceDirectory = join(root, "src", id);
    const directory = join(root, "bundles", id);
    await mkdir(sourceDirectory, { recursive: true });
    await writeFile(
      join(sourceDirectory, "pbconfig.ts"),
      `export default {\n  name: "${id}",\n  description: "${sourceDescription}",\n  version: "${sourceVersion}",\n  icon: "${icon}",\n  language: "en",\n  contentRating: "Everyone",\n  capabilities: ["chapter"],\n  badges: [],\n  developers: [{ name: "corruptbytes" }],\n};\n`,
    );
    await mkdir(join(directory, "static"), { recursive: true });
    await writeFile(join(directory, "index.js"), "(() => {})();\n");
    if (icon !== ".") await writeFile(join(directory, "static", icon), "icon\n");

    const sourceInfo = {
      name: id,
      description: sourceDescription,
      version: sourceVersion,
      icon,
      language: "en",
      contentRating: "Everyone",
      capabilities: ["chapter"],
      badges: [],
      developers: [{ name: "corruptbytes" }],
      id,
    };
    const info = { ...sourceInfo, ...infoOverrides };
    listedSources.push({ ...info, ...listedOverrides });
    await writeFile(join(directory, "info.json"), JSON.stringify(info));
  }
  await writeFile(
    join(root, "bundles", "versioning.json"),
    JSON.stringify({
      buildTime: "2026-08-08T00:00:00.000Z",
      builtWith: { toolchain: "test", types: "test" },
      repository: { name: "test", description: "test" },
      sources: listedSources,
    }),
  );

  if (symlinkIcon) {
    const outsideIcon = join(root, "outside-icon.png");
    await writeFile(outsideIcon, "outside icon\n");
    const iconPath = join(root, "bundles", sourceIds[0], "static", icon);
    await rm(iconPath, { force: true });
    await symlink(relative(dirname(iconPath), outsideIcon), iconPath);
  }

  if (addOrphan) {
    await mkdir(join(root, "bundles", "Obsolete"), { recursive: true });
    await writeFile(join(root, "bundles", "Obsolete", "index.js"), "stale\n");
  }
  return root;
}

async function replaceWithSymlink(path, target, content = "outside\n") {
  await rm(path, { recursive: true, force: true });
  if (content === undefined) {
    await mkdir(target, { recursive: true });
  } else {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  await symlink(relative(dirname(path), target), path);
}

async function makeFifo(path) {
  try {
    await execFileAsync("mkfifo", [path]);
    return true;
  } catch (error) {
    const message = String(error?.stderr ?? error?.message ?? error);
    if (
      error?.code === "ENOENT" ||
      ["EACCES", "EPERM", "ENOTSUP", "EOPNOTSUPP"].includes(error?.code) ||
      (error?.code === 1 &&
        /not supported|operation not permitted|permission denied/i.test(message))
    ) {
      return false;
    }
    throw error;
  }
}

test("version utilities enforce semantic versions and prerelease ordering", () => {
  assert.equal(isValidSemver("1.0.0-alpha.1"), true);
  assert.equal(isValidSemver("1.0"), false);
  assert.equal(isValidSemver("1.0.0-alpha.01"), false);
  assert.equal(compareSemver("1.0.0-alpha.2", "1.0.0-alpha.1"), 1);
  assert.equal(
    compareSemver("1.0.0-alpha.100000000000000000000", "1.0.0-alpha.99999999999999999999"),
    1,
  );
  assert.equal(compareSemver("1.0.0", "1.0.0-rc.1"), 1);
});

test("source ID ordering is deterministic by JavaScript code units", async () => {
  const { root } = await releaseFixture({ a: "1.0.0-alpha.1", B: "1.0.0-alpha.1" });
  try {
    const result = await verifyVersionBumps({ root, files: [] });
    assert.deepEqual(result.sources, ["B", "a"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("version extraction is comment-safe, quote-safe, and limited to the default object", () => {
  const source = `
    // version: "0.0.1"
    const nested = { version: "0.0.2" };
    export default {
      "version": "1.0.0-alpha.1" as const,
      nested,
    } satisfies ExtensionInfo;
  `;
  assert.equal(extractVersion(source, "fixture/pbconfig.ts"), "1.0.0-alpha.1");
});

test("version extraction does not execute config code", () => {
  const source = `
    const sideEffect = (() => { throw new Error("must not execute"); })();
    export default { version: "1.0.0" };
  `;
  assert.equal(extractVersion(source), "1.0.0");
});

test("version extraction rejects object shapes that can change the runtime version", () => {
  const cases = [
    {
      name: "spread",
      source: `const metadata = { version: "2.0.0" }; export default { version: "1.0.0", ...metadata };`,
      error: /must not contain object spreads/,
    },
    {
      name: "computed property",
      source: `export default { version: "1.0.0", ["version"]: "2.0.0" };`,
      error: /must not contain computed properties/,
    },
    {
      name: "getter",
      source: `export default { version: "1.0.0", get version() { return "2.0.0"; } };`,
      error: /must declare exactly one literal version property/,
    },
    {
      name: "setter",
      source: `export default { version: "1.0.0", set version(value) {} };`,
      error: /must declare exactly one literal version property/,
    },
    {
      name: "method",
      source: `export default { version: "1.0.0", version() { return "2.0.0"; } };`,
      error: /must declare exactly one literal version property/,
    },
    {
      name: "duplicate",
      source: `export default { version: "1.0.0", version: "2.0.0" };`,
      error: /must declare exactly one literal version property/,
    },
  ];

  for (const { name, source, error } of cases) {
    assert.throws(() => extractVersion(source, `fixture/${name}.ts`), error);
  }
});

test("static extension metadata extraction maps Paperback enum members", () => {
  const source = `
    import { ContentRating, SourceIntents, type ExtensionInfo } from "@paperback/types";
    export default {
      name: "Fixture",
      description: "Static fixture",
      version: "1.0.0",
      icon: "icon.png",
      language: "en",
      contentRating: ContentRating.ADULT,
      capabilities: [SourceIntents.CHAPTER_PROVIDING, SourceIntents.SEARCH_RESULT_PROVIDING],
      badges: [{ label: "Static", textColor: "#fff", backgroundColor: "#000" }],
      developers: [{ name: "corruptbytes" }],
    } satisfies ExtensionInfo;
  `;
  assert.deepEqual(extractExtensionInfo(source, "fixture/pbconfig.ts"), {
    name: "Fixture",
    description: "Static fixture",
    version: "1.0.0",
    icon: "icon.png",
    language: "en",
    contentRating: "ADULT",
    capabilities: [1, 64],
    badges: [{ label: "Static", textColor: "#fff", backgroundColor: "#000" }],
    developers: [{ name: "corruptbytes" }],
  });
});

test("static metadata evaluation charges expanded alias costs", () => {
  const repeatedLayers = (count) => {
    const lines = ['const layer0 = ["x"];'];
    for (let index = 1; index <= count; index += 1) {
      lines.push(`const layer${index} = [layer${index - 1}, layer${index - 1}];`);
    }
    lines.push(`export default { version: "1.0.0", data: layer${count} };`);
    return lines.join("\n");
  };

  const normal = extractExtensionInfo(repeatedLayers(10), "fixture/normal-layers.ts");
  assert.equal(normal.data.length, 2);
  assert.equal(normal.data[0].length, 2);

  assert.throws(
    () => extractExtensionInfo(repeatedLayers(25), "fixture/repeated-layers.ts"),
    /static metadata complexity\/size budget/,
  );
});

test("static metadata evaluation validates unused constants and cycles", () => {
  for (const source of [
    `const unused = getValue(); export default { version: "1.0.0" };`,
    `const cycle = cycle; export default { version: "1.0.0" };`,
  ]) {
    assert.throws(
      () => extractExtensionInfo(source),
      /unsupported|dynamic|complexity\/size budget/,
    );
  }
});

test("static metadata evaluation rejects a const reference in the temporal dead zone", () => {
  assert.throws(
    () =>
      extractExtensionInfo(
        `const value = later; const later = "ok"; export default { version: "1.0.0", value };`,
      ),
    /unsupported|dynamic/,
  );
});

test("static metadata evaluation rejects default references to later constants", () => {
  assert.throws(
    () =>
      extractExtensionInfo(
        `export default { version: "1.0.0", value: later }; const later = "ok";`,
      ),
    /unsupported|dynamic/,
  );
});

test("static metadata evaluation applies TDZ to left-to-right const declarators", () => {
  assert.throws(
    () =>
      extractExtensionInfo(`const a = b, b = "x"; export default { version: "1.0.0", value: a };`),
    /unsupported|dynamic/,
  );
});

test("static metadata evaluation accepts earlier constants and textually later imports", () => {
  const result = extractExtensionInfo(
    `const label = "ok";
export default { version: "1.0.0", name: label, contentRating: ContentRating.ADULT };
import { ContentRating } from "@paperback/types";`,
  );
  assert.deepEqual(result, {
    version: "1.0.0",
    name: "ok",
    contentRating: "ADULT",
  });
});

test("static metadata evaluation validates later unused constants after the default export", () => {
  const result = extractExtensionInfo(`export default { version: "1.0.0" }; const later = "ok";`);
  assert.equal(result.version, "1.0.0");

  assert.throws(
    () => extractExtensionInfo(`export default { version: "1.0.0" }; const later = getValue();`),
    /unsupported|dynamic/,
  );
});

test("pre-parser guard rejects ten-thousand nested delimiters in a constrained child", async () => {
  const versionUtilsUrl = new URL("./version-utils.mjs", import.meta.url).href;
  const childScript = `
    import { extractVersion } from ${JSON.stringify(versionUtilsUrl)};
    const source = "(".repeat(10000) + "1" + ")".repeat(10000);
    try {
      extractVersion(source, "fixture/deep.ts");
      process.exitCode = 2;
    } catch (error) {
      if (!/nesting depth exceeds 128/.test(error?.message ?? "")) {
        console.error(error);
        process.exitCode = 3;
      } else {
        console.log(error.message);
      }
    }
  `;
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--max-old-space-size=64", "--input-type=module", "-e", childScript],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  assert.match(stdout, /nesting depth exceeds 128/);
});

test("pre-parser guard ignores delimiters in escaped strings and comments", () => {
  const opens = "(".repeat(5000);
  const closes = ")".repeat(5000);
  const source = `const text = "${opens}"; // ${closes}\n/* ${opens} ${closes} */\nexport default { version: "1.0.0", value: text };`;
  const result = extractExtensionInfo(source, "fixture/delimiter-text.ts");
  assert.equal(result.value, opens);
});

test("pre-parser guard rejects mismatched and unclosed syntax before parsing", () => {
  for (const source of [
    'export default { version: "1.0.0" ] ;',
    'export default { version: "1.0.0";',
    'export default { version: "unterminated };',
    "/* unterminated comment",
  ]) {
    assert.throws(() => extractVersion(source, "fixture/unsafe-syntax.ts"), /before parsing/);
  }
});

test("metadata parsers enforce the shared pbconfig source byte cap before parsing", () => {
  const oversized = `export default { version: "1.0.0", value: "${"x".repeat(PB_CONFIG_MAX_BYTES)}" };`;
  assert.throws(
    () => extractVersion(oversized, "fixture/oversized-pbconfig.ts"),
    /maximum pbconfig source size of 262144 bytes \(256 KiB\)/,
  );
});

test("static metadata rejects non-computed __proto__ keys at every object level", () => {
  assert.throws(
    () =>
      extractExtensionInfo(
        `const nested = { __proto__: { polluted: true } }; export default { version: "1.0.0", nested: nested };`,
      ),
    /non-computed __proto__ property/,
  );
  assert.throws(
    () => extractExtensionInfo(`export default { version: "1.0.0", "__proto__": {} };`),
    /non-computed __proto__ property/,
  );
  assert.throws(
    () => extractVersion(`export default { version: "1.0.0", __proto__: {} };`),
    /non-computed __proto__ property/,
  );
});

test("static extension metadata extraction rejects dynamic metadata", () => {
  const cases = [
    `const value = getValue(); export default { version: "1.0.0", value };`,
    `const value = { version: "1.0.0" }; export default { ...value };`,
    `export default { version: "1.0.0", ["name"]: "dynamic" };`,
    `export default { version: "1.0.0", get name() { return "dynamic"; } };`,
    `import "evil"; export default { version: "1.0.0" };`,
    `import {} from "evil"; export default { version: "1.0.0" };`,
    `const value = 1; const value = 2; export default { version: "1.0.0", value };`,
    `import { constructor } from "@paperback/types"; export default { version: "1.0.0" };`,
    `import { __proto__ } from "@paperback/types"; export default { version: "1.0.0" };`,
    `import { toString } from "@paperback/types"; export default { version: "1.0.0" };`,
    `import { ContentRating } from "@paperback/types"; export default { version: "1.0.0", contentRating: ContentRating.constructor };`,
    `import { ContentRating } from "@paperback/types"; export default { version: "1.0.0", contentRating: ContentRating.__proto__ };`,
    `import { ContentRating } from "@paperback/types"; export default { version: "1.0.0", contentRating: ContentRating.toString };`,
    `import * as Types from "@paperback/types"; export default { version: "1.0.0", contentRating: Types.ContentRating.constructor };`,
  ];
  for (const source of cases) {
    assert.throws(
      () => extractExtensionInfo(source),
      /unsupported|dynamic|computed|spreads|duplicate/,
    );
  }
});

test("version bumps reject implementation edits without a higher source version", async () => {
  const { root, base } = await releaseFixture();
  try {
    await writeFile(join(root, "src", "Alpha", "main.ts"), "export default { changed: true };\n");
    await assert.rejects(
      verifyVersionBumps({ root, base }),
      /Alpha changed production code but version did not advance \(1\.0\.0-alpha\.1 -> 1\.0\.0-alpha\.1\)/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("version bumps allow a higher source version for implementation edits", async () => {
  const { root, base } = await releaseFixture();
  try {
    await writeSource(root, "Alpha", "1.0.0-alpha.2", {
      "main.ts": "export default { changed: true };\n",
    });
    const result = await verifyVersionBumps({ root, base });
    assert.equal(result.checked, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("version bumps reject downgrades", async () => {
  const { root, base } = await releaseFixture({ Alpha: "1.0.0-alpha.2" });
  try {
    await writeSource(root, "Alpha", "1.0.0-alpha.1", {
      "main.ts": "export default { changed: true };\n",
    });
    await assert.rejects(
      verifyVersionBumps({ root, base }),
      /Alpha changed production code but version did not advance \(1\.0\.0-alpha\.2 -> 1\.0\.0-alpha\.1\)/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("version bump verification rejects a symlinked source directory", async () => {
  const { root, base } = await releaseFixture({
    Alpha: "1.0.0-alpha.1",
    Beta: "1.0.0-alpha.1",
  });
  try {
    const alphaDirectory = join(root, "src", "Alpha");
    await rm(alphaDirectory, { recursive: true, force: true });
    await symlink(relative(dirname(alphaDirectory), join(root, "src", "Beta")), alphaDirectory);
    await assert.rejects(
      verifyVersionBumps({ root, base }),
      /src\/Alpha must be a real source directory/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("version bump verification rejects non-directory source entries", async () => {
  const { root, base } = await releaseFixture();
  try {
    const alphaDirectory = join(root, "src", "Alpha");
    await rm(alphaDirectory, { recursive: true, force: true });
    await writeFile(alphaDirectory, "not a source directory\n");
    await assert.rejects(
      verifyVersionBumps({ root, base }),
      /src\/Alpha must be a real source directory/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("version bump verification rejects symlinked pbconfig metadata", async () => {
  const { root, base } = await releaseFixture({
    Alpha: "1.0.0-alpha.1",
    Beta: "1.0.0-alpha.1",
  });
  try {
    const alphaConfig = join(root, "src", "Alpha", "pbconfig.ts");
    const betaConfig = join(root, "src", "Beta", "pbconfig.ts");
    await rm(alphaConfig, { force: true });
    await symlink(relative(dirname(alphaConfig), betaConfig), alphaConfig);
    await assert.rejects(
      verifyVersionBumps({ root, base }),
      /src\/Alpha\/pbconfig\.ts must be a regular, non-symlink file/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bundle verification rejects a FIFO pbconfig instead of skipping the source", async (t) => {
  const root = await bundleFixture();
  try {
    const configPath = join(root, "src", "Alpha", "pbconfig.ts");
    await rm(configPath, { force: true });
    if (!(await makeFifo(configPath))) {
      t.skip("mkfifo is unavailable on this platform");
      return;
    }
    await rm(join(root, "bundles", "Alpha"), { recursive: true, force: true });
    const versioningPath = join(root, "bundles", "versioning.json");
    const versioning = JSON.parse(await readFile(versioningPath, "utf8"));
    versioning.sources = [];
    await writeFile(versioningPath, JSON.stringify(versioning));

    await assert.rejects(
      verifyBundles(root),
      /src\/Alpha\/pbconfig\.ts must be a regular, non-symlink file/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bundle verification rejects a directory pbconfig instead of skipping the source", async () => {
  const root = await bundleFixture();
  try {
    const configPath = join(root, "src", "Alpha", "pbconfig.ts");
    await rm(configPath, { force: true });
    await mkdir(configPath);
    await rm(join(root, "bundles", "Alpha"), { recursive: true, force: true });
    const versioningPath = join(root, "bundles", "versioning.json");
    const versioning = JSON.parse(await readFile(versioningPath, "utf8"));
    versioning.sources = [];
    await writeFile(versioningPath, JSON.stringify(versioning));

    await assert.rejects(
      verifyBundles(root),
      /src\/Alpha\/pbconfig\.ts must be a regular, non-symlink file/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("config-only metadata edits require a version bump", async () => {
  const { root, base } = await releaseFixture();
  try {
    await writeFile(
      join(root, "src", "Alpha", "pbconfig.ts"),
      `export default { name: "Alpha", version: "1.0.0-alpha.1", icon: "icon.png", description: "changed" };\n`,
    );
    await assert.rejects(
      verifyVersionBumps({ root, base }),
      /Alpha changed production code but version did not advance \(1\.0\.0-alpha\.1 -> 1\.0\.0-alpha\.1\)/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("version checks reject a config-only downgrade even without changed-file input", async () => {
  const { root, base } = await releaseFixture({ Alpha: "1.0.0-alpha.2" });
  try {
    await writeSource(root, "Alpha", "1.0.0-alpha.1");
    await assert.rejects(
      verifyVersionBumps({ root, base, files: [] }),
      /Alpha version regressed \(1\.0\.0-alpha\.2 -> 1\.0\.0-alpha\.1\)/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("version bump verification rejects an oversized historical pbconfig", async () => {
  const { root } = await releaseFixture();
  try {
    const configPath = join(root, "src", "Alpha", "pbconfig.ts");
    await writeFile(
      configPath,
      `// ${"x".repeat(300 * 1024)}\nexport default { name: "Alpha", version: "1.0.0-alpha.1", icon: "icon.png" };\n`,
    );
    await runGit(root, ["add", configPath]);
    await runGit(root, ["commit", "-m", "oversized historical metadata"]);
    const oversizedBase = await runGit(root, ["rev-parse", "HEAD"]);

    await writeSource(root, "Alpha", "1.0.0-alpha.2");
    await assert.rejects(
      verifyVersionBumps({ root, base: oversizedBase, files: [] }),
      /maximum pbconfig source size of 262144 bytes \(256 KiB\)/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("version bumps include both sides of cross-source renames", async () => {
  const { root, base } = await releaseFixture({
    Alpha: "1.0.0-alpha.1",
    Beta: "1.0.0-alpha.2",
  });
  try {
    await rename(join(root, "src", "Alpha", "main.ts"), join(root, "src", "Beta", "moved.ts"));
    await runGit(root, ["add", "-A"]);
    await assert.rejects(
      verifyVersionBumps({ root, base }),
      /Alpha changed production code but version did not advance \(1\.0\.0-alpha\.1 -> 1\.0\.0-alpha\.1\)/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an all-zero CI base falls back safely when no parent exists", async () => {
  const { root } = await releaseFixture();
  try {
    const result = await verifyVersionBumps({ root, base: "0".repeat(40) });
    assert.equal(result.checked, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("shared implementation edits require every existing source to advance", async () => {
  const { root, base } = await releaseFixture({ Alpha: "1.0.0-alpha.1", Beta: "1.0.0-alpha.1" });
  try {
    await mkdir(join(root, "src", "shared"), { recursive: true });
    await writeFile(join(root, "src", "shared", "http.ts"), "export const changed = true;\n");
    await writeSource(root, "Alpha", "1.0.0-alpha.2", { "main.ts": "changed\n" });
    await assert.rejects(
      verifyVersionBumps({ root, base }),
      /Beta changed production code but version did not advance/,
    );

    await writeSource(root, "Beta", "1.0.0-alpha.2", { "main.ts": "changed\n" });
    const result = await verifyVersionBumps({ root, base });
    assert.equal(result.checked, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("test fixtures and documentation edits do not require a bump", async () => {
  const { root, base } = await releaseFixture();
  try {
    await writeFile(join(root, "src", "Alpha", "reader.test.ts"), "test\n");
    await writeFile(join(root, "src", "Alpha", "reader.spec.ts"), "test\n");
    await writeFile(join(root, "src", "Alpha", "test-fixtures.ts"), "fixture\n");
    await writeFile(join(root, "src", "Alpha", "README.md"), "source documentation\n");
    await writeFile(join(root, "README.md"), "documentation\n");
    const result = await verifyVersionBumps({ root, base });
    assert.equal(result.checked, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("new sources only need a valid semantic version", async () => {
  const { root, base } = await releaseFixture();
  try {
    await writeSource(root, "NewSource", "1.0.0-alpha.1", { "main.ts": "new\n" });
    const result = await verifyVersionBumps({ root, base });
    assert.equal(result.checked, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bundle verification accepts source metadata generated from pbconfig", async () => {
  const root = await bundleFixture();
  try {
    const result = await verifyBundles(root);
    assert.deepEqual(result.sourceIds, ["Alpha"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bundle verification never executes pbconfig side effects or swaps source paths", async () => {
  const root = await bundleFixture();
  const sentinel = join(root, "pbconfig-executed.txt");
  const sourceDirectory = join(root, "src", "Alpha");
  const swappedSourceDirectory = join(root, "swapped-src");
  try {
    const pbconfigPath = join(sourceDirectory, "pbconfig.ts");
    const original = await readFile(pbconfigPath, "utf8");
    await writeFile(
      pbconfigPath,
      `import { renameSync, writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(sentinel)}, "executed");
renameSync(${JSON.stringify(sourceDirectory)}, ${JSON.stringify(swappedSourceDirectory)});
${original}`,
    );

    await assert.rejects(verifyBundles(root), /unsupported runtime import/);
    await assert.rejects(access(sentinel), { code: "ENOENT" });
    await access(sourceDirectory);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bundle verification rejects a replaced bundles root before opening files", async () => {
  const root = await bundleFixture();
  try {
    const bundleRoot = join(root, "bundles");
    const originalBundleRoot = join(root, "original-bundles");
    await rename(bundleRoot, originalBundleRoot);
    await symlink(relative(root, originalBundleRoot), bundleRoot);
    await assert.rejects(verifyBundles(root), /bundles must be a real directory/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("safe reads reject a same-path inode-swapped pinned root", async () => {
  const root = await temporaryDirectory();
  try {
    const safeRoot = join(root, "safe-root");
    const replacementRoot = join(root, "replacement-root");
    await mkdir(safeRoot, { recursive: true });
    await writeFile(join(safeRoot, "metadata.json"), "{}\n");
    const context = await pinSafeDirectory(safeRoot, "safe-root");

    await rename(safeRoot, replacementRoot);
    await mkdir(safeRoot, { recursive: true });
    await writeFile(join(safeRoot, "metadata.json"), '{"swapped":true}\n');

    await assert.rejects(
      readSafeFile(join(safeRoot, "metadata.json"), {
        rootPath: context,
        label: "safe-root/metadata.json",
        maxBytes: 1024,
      }),
      /safe-root changed location while it was being used/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("safe reads require a positive caller-supplied byte limit", async () => {
  const root = await temporaryDirectory();
  try {
    const safeRoot = join(root, "safe-root");
    const metadataPath = join(safeRoot, "metadata.json");
    await mkdir(safeRoot, { recursive: true });
    await writeFile(metadataPath, "{}\n");

    for (const maxBytes of [undefined, 0, -1, 1.5, Infinity]) {
      await assert.rejects(
        readSafeFile(metadataPath, {
          rootPath: safeRoot,
          label: "safe-root/metadata.json",
          ...(maxBytes === undefined ? {} : { maxBytes }),
        }),
        /maxBytes must be a positive safe integer/,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("safe reads reject regular files at maxBytes + 1 without unbounded reads", async () => {
  const root = await temporaryDirectory();
  try {
    const safeRoot = join(root, "safe-root");
    const metadataPath = join(safeRoot, "metadata.json");
    await mkdir(safeRoot, { recursive: true });
    await writeFile(metadataPath, "0123456789");

    await assert.rejects(
      readSafeFile(metadataPath, {
        rootPath: safeRoot,
        label: "safe-root/metadata.json",
        maxBytes: 9,
      }),
      /safe-root\/metadata\.json exceeds maximum size of 9 bytes/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("safe reads reject FIFOs before open without blocking", async (t) => {
  const root = await temporaryDirectory();
  try {
    const safeRoot = join(root, "safe-root");
    const fifoPath = join(safeRoot, "metadata.pipe");
    await mkdir(safeRoot, { recursive: true });
    if (!(await makeFifo(fifoPath))) {
      t.skip("mkfifo is unavailable on this platform");
      return;
    }

    let timeout;
    try {
      await Promise.race([
        assert.rejects(
          readSafeFile(fifoPath, {
            rootPath: safeRoot,
            label: "safe-root/metadata.pipe",
            maxBytes: 64,
          }),
          /safe-root\/metadata\.pipe must be a regular, non-symlink file/,
        ),
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error("FIFO read did not reject promptly")), 500);
        }),
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bundle verification uses the same code-unit ordering for sources and bundles", async () => {
  const root = await bundleFixture({ sourceIds: ["a", "B"] });
  try {
    const result = await verifyBundles(root);
    assert.deepEqual(result.sourceIds, ["B", "a"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bundle verification rejects stale source metadata", async () => {
  const root = await bundleFixture({ infoOverrides: { description: "Old description" } });
  try {
    await assert.rejects(
      verifyBundles(root),
      /Alpha bundle metadata is stale compared with pbconfig\.ts/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bundle verification rejects oversized info metadata before parsing", async () => {
  const root = await bundleFixture();
  try {
    const infoPath = join(root, "bundles", "Alpha", "info.json");
    const info = JSON.parse(await readFile(infoPath, "utf8"));
    info.description = "x".repeat(256 * 1024);
    await writeFile(infoPath, JSON.stringify(info));
    await assert.rejects(
      verifyBundles(root),
      /Alpha\/info\.json exceeds maximum size of 262144 bytes/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("version bump verification rejects oversized pbconfig metadata before parsing", async () => {
  const { root, base } = await releaseFixture();
  try {
    const configPath = join(root, "src", "Alpha", "pbconfig.ts");
    const config = await readFile(configPath, "utf8");
    await writeFile(configPath, `${"/".repeat(256 * 1024)}${config}`);
    await assert.rejects(
      verifyVersionBumps({ root, base }),
      /src\/Alpha\/pbconfig\.ts exceeds maximum size of 262144 bytes/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bundle verification rejects mismatched versioning entries", async () => {
  const root = await bundleFixture({ listedOverrides: { version: "1.0.0-alpha.2" } });
  try {
    await assert.rejects(
      verifyBundles(root),
      /Alpha has inconsistent info\.json and versioning\.json metadata/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bundle verification rejects orphan directories", async () => {
  const root = await bundleFixture({ addOrphan: true });
  try {
    await assert.rejects(verifyBundles(root), /Physical bundle\/source mismatch/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bundle verification rejects directory icons", async () => {
  const root = await bundleFixture({ icon: "." });
  try {
    await assert.rejects(verifyBundles(root), /regular, non-symlink icon file/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bundle verification rejects symlink icons outside static", async () => {
  const root = await bundleFixture({ symlinkIcon: true });
  try {
    await assert.rejects(verifyBundles(root), /regular, non-symlink icon file/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bundle verification rejects symlink source bundle directories", async () => {
  const root = await bundleFixture();
  try {
    const outside = join(root, "outside-bundle");
    await replaceWithSymlink(join(root, "bundles", "Alpha"), outside, undefined);
    await assert.rejects(verifyBundles(root), /bundles\/Alpha must not be a symbolic link/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bundle verification rejects symlink orphan directories instead of ignoring them", async () => {
  const root = await bundleFixture();
  try {
    const orphan = join(root, "bundles", "Obsolete");
    await replaceWithSymlink(orphan, join(root, "outside-orphan"), undefined);
    await assert.rejects(verifyBundles(root), /bundles\/Obsolete must not be a symbolic link/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const artifact of ["index.html", "versioning.json"]) {
  test(`bundle verification rejects a symlink root ${artifact}`, async () => {
    const root = await bundleFixture();
    try {
      await replaceWithSymlink(join(root, "bundles", artifact), join(root, `outside-${artifact}`));
      await assert.rejects(
        verifyBundles(root),
        new RegExp(`bundles/${artifact} must not be a symbolic link`),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

for (const artifact of ["index.js", "info.json"]) {
  test(`bundle verification rejects a symlink source ${artifact}`, async () => {
    const root = await bundleFixture();
    try {
      await replaceWithSymlink(
        join(root, "bundles", "Alpha", artifact),
        join(root, `outside-${artifact}`),
      );
      await assert.rejects(
        verifyBundles(root),
        new RegExp(`Alpha/${artifact} must be a regular, non-symlink file`),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
