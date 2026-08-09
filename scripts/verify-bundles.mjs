import { deepStrictEqual } from "node:assert/strict";
import { lstat, readdir, realpath } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import {
  assertPinnedDirectory,
  assertSafeRegularFile,
  pinSafeDirectory,
  readSafeFile,
} from "./safe-files.mjs";
import {
  compareSourceIds,
  extractExtensionInfo,
  isValidSemver,
  PB_CONFIG_MAX_BYTES,
} from "./version-utils.mjs";

// Generated metadata is normally only a few KiB. Keep explicit byte caps at
// every text-file boundary so malformed or swapped artifacts cannot trigger
// unbounded reads or JSON parsing allocations.
const INFO_JSON_MAX_BYTES = 256 * 1024;
const VERSIONING_JSON_MAX_BYTES = 4 * 1024 * 1024;

async function readJson(path, rootPath, label, maxBytes) {
  return JSON.parse(await readSafeFile(path, { rootPath, label, maxBytes }));
}

async function assertRealDirectory(path, label) {
  const stats = await lstat(path);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory.`);
  }
}

async function sourceDirectories(sourceRoot, rootContext) {
  if (rootContext) await assertPinnedDirectory(rootContext);
  else await assertRealDirectory(sourceRoot, "src");
  const entries = await readdir(sourceRoot, { withFileTypes: true });
  if (rootContext) await assertPinnedDirectory(rootContext);
  const directories = [];
  for (const entry of entries) {
    const path = join(sourceRoot, entry.name);
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) {
      throw new Error(`src/${entry.name} must be a real directory or file.`);
    }
    if (!stats.isDirectory()) continue;
    try {
      const pbconfigStats = await lstat(join(path, "pbconfig.ts"));
      if (!pbconfigStats.isFile() || pbconfigStats.isSymbolicLink()) {
        throw new Error(`src/${entry.name}/pbconfig.ts must be a regular, non-symlink file.`);
      }
      directories.push(entry.name);
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ENOENT") continue;
      throw error;
    }
  }
  return directories.sort(compareSourceIds);
}

async function bundleDirectories(bundleRoot, rootContext) {
  if (rootContext) await assertPinnedDirectory(rootContext);
  else await assertRealDirectory(bundleRoot, "bundles");
  const entries = await readdir(bundleRoot, { withFileTypes: true });
  if (rootContext) await assertPinnedDirectory(rootContext);
  const directories = [];
  for (const entry of entries) {
    const path = join(bundleRoot, entry.name);
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) {
      throw new Error(`bundles/${entry.name} must not be a symbolic link.`);
    }
    if (stats.isDirectory()) {
      directories.push(entry.name);
      continue;
    }
    if (entry.name !== "index.html" && entry.name !== "versioning.json") {
      throw new Error(`bundles/${entry.name} is not a recognized bundle artifact.`);
    }
  }
  return directories.sort(compareSourceIds);
}

async function sourceMetadata(sourceRoot, id, rootContext) {
  const path = join(sourceRoot, id, "pbconfig.ts");
  const sourceText = await readSafeFile(path, {
    rootPath: rootContext ?? sourceRoot,
    label: `${id}/pbconfig.ts`,
    maxBytes: PB_CONFIG_MAX_BYTES,
  });
  const sourceInfo = extractExtensionInfo(sourceText, `${id}/pbconfig.ts`);
  if (!sourceInfo || typeof sourceInfo !== "object" || Array.isArray(sourceInfo)) {
    throw new Error(`${id}/pbconfig.ts does not export an ExtensionInfo object.`);
  }
  return JSON.parse(JSON.stringify({ ...sourceInfo, id }));
}

function assertSame(actual, expected, message) {
  try {
    deepStrictEqual(actual, expected);
  } catch (error) {
    throw new Error(`${message}\n${error instanceof Error ? error.message : String(error)}`);
  }
}

async function assertIconFile(staticRoot, iconPath, id, rootContext) {
  const staticStats = await lstat(staticRoot);
  if (!staticStats.isDirectory() || staticStats.isSymbolicLink()) {
    throw new Error(`${id}/static must be a real directory.`);
  }
  if (iconPath === staticRoot) {
    throw new Error(`${id}/info.json must reference a regular, non-symlink icon file.`);
  }

  await assertSafeRegularFile(iconPath, {
    rootPath: rootContext ?? staticRoot,
    label: `${id}/info.json icon`,
    fileDescription: "icon file",
  });
  const staticRealPath = await realpath(staticRoot);
  const iconRealPath = await realpath(iconPath);
  if (iconRealPath !== staticRealPath && !iconRealPath.startsWith(`${staticRealPath}${sep}`)) {
    throw new Error(`${id}/info.json declares an icon outside its static directory.`);
  }
}

export async function verifyBundles(root = process.cwd()) {
  const sourceRoot = join(root, "src");
  const bundleRoot = join(root, "bundles");
  const sourceRootContext = await pinSafeDirectory(sourceRoot, "src");
  const bundleRootContext = await pinSafeDirectory(bundleRoot, "bundles");
  const sourceIds = await sourceDirectories(sourceRoot, sourceRootContext);
  const physicalBundleIds = await bundleDirectories(bundleRoot, bundleRootContext);
  if (JSON.stringify(physicalBundleIds) !== JSON.stringify(sourceIds)) {
    throw new Error(
      `Physical bundle/source mismatch. Expected [${sourceIds.join(", ")}], received [${physicalBundleIds.join(", ")}].`,
    );
  }

  const versioning = await readJson(
    join(bundleRoot, "versioning.json"),
    bundleRootContext,
    "bundles/versioning.json",
    VERSIONING_JSON_MAX_BYTES,
  );
  if (!versioning || typeof versioning !== "object" || !Array.isArray(versioning.sources)) {
    throw new Error("bundles/versioning.json does not contain a sources array.");
  }

  const bundledIds = versioning.sources.map((source) => source?.id);
  if (bundledIds.some((id) => typeof id !== "string")) {
    throw new Error("bundles/versioning.json contains a source without a string ID.");
  }
  bundledIds.sort(compareSourceIds);
  if (new Set(bundledIds).size !== bundledIds.length) {
    throw new Error("bundles/versioning.json contains duplicate source IDs.");
  }
  if (JSON.stringify(bundledIds) !== JSON.stringify(sourceIds)) {
    throw new Error(
      `Bundle/source mismatch. Expected [${sourceIds.join(", ")}], received [${bundledIds.join(", ")}].`,
    );
  }

  await assertSafeRegularFile(join(bundleRoot, "index.html"), {
    rootPath: bundleRootContext,
    label: "bundles/index.html",
  });
  for (const id of sourceIds) {
    const directory = join(bundleRoot, id);
    await assertRealDirectory(directory, `bundles/${id}`);
    const info = await readJson(
      join(directory, "info.json"),
      bundleRootContext,
      `${id}/info.json`,
      INFO_JSON_MAX_BYTES,
    );
    await assertSafeRegularFile(join(directory, "index.js"), {
      rootPath: bundleRootContext,
      label: `${id}/index.js`,
    });
    if (info.id !== id) throw new Error(`${id}/info.json declares the wrong source ID.`);
    if (!isValidSemver(info.version)) {
      throw new Error(`${id}/info.json does not declare a valid semantic version.`);
    }
    if (typeof info.icon !== "string" || !info.icon) {
      throw new Error(`${id}/info.json does not declare an icon.`);
    }
    const staticRoot = resolve(directory, "static");
    const iconPath = resolve(staticRoot, info.icon);
    if (iconPath !== staticRoot && !iconPath.startsWith(`${staticRoot}${sep}`)) {
      throw new Error(`${id}/info.json declares an icon outside its static directory.`);
    }
    const listed = versioning.sources.find((source) => source.id === id);
    assertSame(listed, info, `${id} has inconsistent info.json and versioning.json metadata.`);
    const sourceInfo = await sourceMetadata(sourceRoot, id, sourceRootContext);
    assertSame(sourceInfo, info, `${id} bundle metadata is stale compared with pbconfig.ts.`);
    await assertIconFile(staticRoot, iconPath, id, bundleRootContext);
  }

  return { sourceIds };
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  try {
    const { sourceIds } = await verifyBundles();
    console.log(`Verified ${sourceIds.length} Paperback source bundles.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
