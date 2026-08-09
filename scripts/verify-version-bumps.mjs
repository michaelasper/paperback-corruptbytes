import { execFile } from "node:child_process";
import { lstat, readdir, realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { assertPinnedDirectory, pinSafeDirectory, readSafeFile } from "./safe-files.mjs";
import {
  PB_CONFIG_MAX_BYTES,
  assertPBConfigSize,
  compareSemver,
  compareSourceIds,
  extractVersion,
  parseSemver,
} from "./version-utils.mjs";

const execFileAsync = promisify(execFile);
// pbconfig.ts files in this repository are small metadata declarations. Keep
// their read bounded so release checks never parse an unbounded source file.

async function git(root, args, options = {}) {
  const { stdout } = await execFileAsync("git", args, {
    ...options,
    cwd: root,
    encoding: "utf8",
  });
  return stdout.trim();
}

function isWithin(rootPath, targetPath) {
  const path = relative(rootPath, targetPath);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !path.startsWith(sep);
}

async function assertRealDirectory(path, label) {
  const stats = await lstat(path);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory.`);
  }
}

async function assertSourceFile(sourceRootReal, path, label) {
  const stats = await lstat(path);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`${label} must be a regular, non-symlink file.`);
  }
  const realPath = await realpath(path);
  if (!isWithin(sourceRootReal, realPath)) {
    throw new Error(`${label} resolves outside the source tree.`);
  }
}

async function sourceDirectories(root, rootContext) {
  const sourceRoot = rootContext?.path ?? join(root, "src");
  if (rootContext) await assertPinnedDirectory(rootContext);
  else await assertRealDirectory(sourceRoot, "src");
  const sourceRootReal = rootContext?.realPath ?? (await realpath(sourceRoot));
  const entries = await readdir(sourceRoot, { withFileTypes: true });
  if (rootContext) await assertPinnedDirectory(rootContext);
  const directories = [];
  for (const entry of entries) {
    const sourcePath = join(sourceRoot, entry.name);
    const sourceStats = await lstat(sourcePath);
    if (sourceStats.isSymbolicLink() || !sourceStats.isDirectory()) {
      throw new Error(`src/${entry.name} must be a real source directory.`);
    }
    const sourceRealPath = await realpath(sourcePath);
    if (!isWithin(sourceRootReal, sourceRealPath)) {
      throw new Error(`src/${entry.name} resolves outside the source tree.`);
    }

    const pbconfigPath = join(sourcePath, "pbconfig.ts");
    let pbconfigStats;
    try {
      pbconfigStats = await lstat(pbconfigPath);
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ENOENT") continue;
      throw error;
    }
    if (!pbconfigStats.isFile() || pbconfigStats.isSymbolicLink()) {
      throw new Error(`src/${entry.name}/pbconfig.ts must be a regular, non-symlink file.`);
    }
    await assertSourceFile(sourceRootReal, pbconfigPath, `src/${entry.name}/pbconfig.ts`);
    directories.push(entry.name);
  }
  return directories.sort(compareSourceIds);
}

function isTestPath(path) {
  return (
    /(?:^|\/)(?:test-fixtures|fixtures|tests|__tests__)(?:\/|(?:\.[^/]+)?$)/.test(path) ||
    /\.(?:test|spec)\.[^/]+$/.test(path)
  );
}

function isDocumentationPath(path) {
  return /(?:^|\/)(?:README|CHANGELOG)(?:\.[^/]+)?$/i.test(path) || /\.(?:md|mdx|txt)$/i.test(path);
}

function isProductionSourcePath(path) {
  if (!path.startsWith("src/") || isTestPath(path) || isDocumentationPath(path)) return false;
  const [, source, file] = path.split("/");
  return Boolean(source && file);
}

function sourceForPath(path) {
  if (!path.startsWith("src/")) return undefined;
  const [, source] = path.split("/");
  return source;
}

async function changedFiles(root, base) {
  // Keep both sides of renames. A cross-source move changes the source that owns the old path,
  // even when the destination is the only path reported by Git's rename-aware name-only output.
  const tracked = await git(root, ["diff", "--name-only", "--no-renames", base, "--"]);
  const untracked = await git(root, ["ls-files", "--others", "--exclude-standard"]);
  return [...tracked.split("\n"), ...untracked.split("\n")]
    .map((path) => path.trim())
    .filter(Boolean)
    .map((path) => path.split(sep).join("/"));
}

async function baseSourceVersion(root, base, source) {
  const path = `src/${source}/pbconfig.ts`;
  try {
    await git(root, ["cat-file", "-e", `${base}:${path}`]);
    let text;
    try {
      text = await git(root, ["show", `${base}:${path}`], {
        maxBuffer: PB_CONFIG_MAX_BYTES + 1,
      });
    } catch (error) {
      if (error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
        throw new Error(
          `${path} exceeds the maximum pbconfig source size of ${PB_CONFIG_MAX_BYTES} bytes (256 KiB).`,
          { cause: error },
        );
      }
      throw error;
    }
    assertPBConfigSize(text, path);
    const version = extractVersion(text, path);
    parseSemver(version, path);
    return version;
  } catch (error) {
    const message = String(error?.stderr ?? error?.message ?? error);
    if (error?.code === 128 && message.includes("path") && message.includes("not in")) {
      return undefined;
    }
    if (message.includes("exists on disk, but not in") || message.includes("does not exist")) {
      return undefined;
    }
    if (message.includes("fatal: invalid object name") || message.includes("fatal: bad object")) {
      throw new Error(`Release base ${base} is not available in the local git checkout.`);
    }
    throw error;
  }
}

async function currentSourceVersion(root, source, rootContext) {
  const sourceRoot = rootContext?.path ?? join(root, "src");
  const path = join(sourceRoot, source, "pbconfig.ts");
  const text = await readSafeFile(path, {
    rootPath: rootContext ?? sourceRoot,
    label: `src/${source}/pbconfig.ts`,
    maxBytes: PB_CONFIG_MAX_BYTES,
  });
  const version = extractVersion(text, relative(root, path));
  parseSemver(version, relative(root, path));
  return version;
}

async function resolveBase(root, explicitBase) {
  const requested = explicitBase?.trim() || process.env.VERSION_BUMP_BASE?.trim();
  if (requested && !/^0{40}(?:0{24})?$/.test(requested)) {
    try {
      await git(root, ["rev-parse", "--verify", `${requested}^{commit}`]);
      return requested;
    } catch {
      throw new Error(`Release base ${requested} is not available in the local git checkout.`);
    }
  }

  try {
    return await git(root, ["rev-parse", "--verify", "HEAD^"]);
  } catch {
    return undefined;
  }
}

export async function verifyVersionBumps({ root = process.cwd(), base, files } = {}) {
  const sourceRootContext = await pinSafeDirectory(join(root, "src"), "src");
  const sources = await sourceDirectories(root, sourceRootContext);
  const currentVersions = new Map();
  for (const source of sources) {
    currentVersions.set(source, await currentSourceVersion(root, source, sourceRootContext));
  }

  const resolvedBase = await resolveBase(root, base);
  if (!resolvedBase) return { checked: false, sources };

  const changed = files ?? (await changedFiles(root, resolvedBase));
  const productionChanges = changed.filter(isProductionSourcePath);
  const sharedChanged = productionChanges.some((path) => sourceForPath(path) === "shared");
  const changedSources = new Set(
    productionChanges
      .map(sourceForPath)
      .filter((source) => source && source !== "shared" && sources.includes(source)),
  );
  if (sharedChanged) for (const source of sources) changedSources.add(source);

  const errors = [];
  for (const source of sources) {
    const current = currentVersions.get(source);
    const previous = await baseSourceVersion(root, resolvedBase, source);
    if (previous === undefined) continue;
    const comparison = compareSemver(current, previous);
    if (comparison < 0 && !changedSources.has(source)) {
      errors.push(`${source} version regressed (${previous} -> ${current}).`);
    } else if (changedSources.has(source) && comparison <= 0) {
      errors.push(
        `${source} changed production code but version did not advance (${previous} -> ${current}).`,
      );
    }
  }

  if (errors.length > 0) throw new Error(errors.join("\n"));
  return { checked: true, base: resolvedBase, sources, changed: changedSources };
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  try {
    const result = await verifyVersionBumps();
    if (result.checked) {
      console.log(
        `Verified release bumps against ${result.base} for ${result.sources.length} source(s).`,
      );
    } else {
      console.log("No git parent is available; release bump check skipped.");
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
