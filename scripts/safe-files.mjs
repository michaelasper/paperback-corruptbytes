import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, relative, sep } from "node:path";

const READ_ONLY_NOFOLLOW = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const READ_CHUNK_BYTES = 64 * 1024;

function isWithin(rootPath, targetPath) {
  const path = relative(rootPath, targetPath);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !path.startsWith(sep);
}

function isWithinOrEqual(rootPath, targetPath) {
  return rootPath === targetPath || isWithin(rootPath, targetPath);
}

function regularFileError(label, cause, fileDescription = "file") {
  return new Error(`${label} must be a regular, non-symlink ${fileDescription}.`, { cause });
}

function sizeLimitError(label, maxBytes) {
  return new Error(`${label} exceeds maximum size of ${maxBytes} bytes.`);
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

export async function pinSafeDirectory(path, label = path) {
  const stats = await lstat(path, { bigint: true });
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory.`);
  }
  const realPath = await realpath(path);
  const recheckedStats = await lstat(path, { bigint: true });
  if (!sameIdentity(stats, recheckedStats)) {
    throw new Error(`${label} changed while its location was being checked.`);
  }
  return { identity: stats, label, path, realPath };
}

export async function assertPinnedDirectory(context) {
  const stats = await lstat(context.path, { bigint: true });
  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    !sameIdentity(stats, context.identity) ||
    (await realpath(context.path)) !== context.realPath
  ) {
    throw new Error(`${context.label} changed location while it was being used.`);
  }
}

async function preflight(path, rootContext, label, fileDescription) {
  await assertPinnedDirectory(rootContext);
  const rootStats = rootContext.identity;
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new Error(`${rootContext.label} must be a real directory.`);
  }

  const parentPath = dirname(path);
  const parentStats = await lstat(parentPath, { bigint: true });
  if (!parentStats.isDirectory() || parentStats.isSymbolicLink()) {
    throw new Error(`${label} parent must be a real directory.`);
  }
  const parentRealPath = await realpath(parentPath);
  if (!isWithinOrEqual(rootContext.realPath, parentRealPath)) {
    throw new Error(`${label} resolves outside ${rootContext.path}.`);
  }

  const targetStats = await lstat(path, { bigint: true });
  if (!targetStats.isFile() || targetStats.isSymbolicLink()) {
    throw regularFileError(label, undefined, fileDescription);
  }
  const targetRealPath = await realpath(path);
  if (!isWithinOrEqual(rootContext.realPath, targetRealPath)) {
    throw new Error(`${label} resolves outside ${rootContext.path}.`);
  }

  return {
    parentIdentity: parentStats,
    parentPath,
    parentRealPath,
    targetIdentity: targetStats,
    targetRealPath,
  };
}

async function revalidate(path, rootContext, label, expected, handleStats) {
  await assertPinnedDirectory(rootContext);
  const parentStats = await lstat(expected.parentPath, { bigint: true });
  const targetStats = await lstat(path, { bigint: true });
  const parentRealPath = await realpath(expected.parentPath);
  const targetRealPath = await realpath(path);
  if (
    parentRealPath !== expected.parentRealPath ||
    targetRealPath !== expected.targetRealPath ||
    !sameIdentity(parentStats, expected.parentIdentity) ||
    targetStats.isSymbolicLink() ||
    !sameIdentity(targetStats, expected.targetIdentity) ||
    !isWithinOrEqual(rootContext.realPath, parentRealPath) ||
    !isWithin(rootContext.realPath, targetRealPath) ||
    (handleStats !== undefined && !sameIdentity(handleStats, expected.targetIdentity))
  ) {
    throw new Error(`${label} changed location while it was being read.`);
  }
}

async function openRegularFile(path, { rootPath, label = path, fileDescription = "file" }) {
  const rootContext = typeof rootPath === "string" ? await pinSafeDirectory(rootPath) : rootPath;
  const expected = await preflight(path, rootContext, label, fileDescription);
  let handle;
  try {
    handle = await open(path, READ_ONLY_NOFOLLOW);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ELOOP") {
      throw regularFileError(label, error, fileDescription);
    }
    throw error;
  }

  try {
    const stats = await handle.stat({ bigint: true });
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw regularFileError(label, undefined, fileDescription);
    }
    await revalidate(path, rootContext, label, expected, stats);
    return { handle, expected, rootContext };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function readBounded(handle, maxBytes, label) {
  const chunks = [];
  const limit = BigInt(maxBytes);
  let position = 0;
  let total = 0;

  while (BigInt(total) <= limit) {
    // Read at most maxBytes + 1 bytes in bounded chunks. The extra byte lets us
    // reject a file that grows after the initial lstat without allocating the
    // whole file or relying on a potentially stale size estimate.
    const remaining = limit + 1n - BigInt(total);
    const length = Number(
      remaining > BigInt(READ_CHUNK_BYTES) ? BigInt(READ_CHUNK_BYTES) : remaining,
    );
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    if (bytesRead === 0) break;

    total += bytesRead;
    position += bytesRead;
    chunks.push(bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead));
    if (BigInt(total) > limit) throw sizeLimitError(label, maxBytes);
  }

  return Buffer.concat(chunks, total).toString("utf8");
}

export async function readSafeFile(path, options = {}) {
  const { rootPath, label = path, fileDescription = "file", maxBytes } = options;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
    throw new RangeError(`${label} maxBytes must be a positive safe integer.`);
  const { handle, expected, rootContext } = await openRegularFile(path, {
    rootPath,
    label,
    fileDescription,
  });
  try {
    const text = await readBounded(handle, maxBytes, label);
    const finalStats = await handle.stat({ bigint: true });
    if (!finalStats.isFile() || finalStats.isSymbolicLink()) {
      throw regularFileError(label, undefined, fileDescription);
    }
    if (finalStats.size > BigInt(maxBytes)) throw sizeLimitError(label, maxBytes);
    await revalidate(path, rootContext, label, expected, finalStats);
    return text;
  } finally {
    await handle.close();
  }
}

export async function assertSafeRegularFile(path, options) {
  const { handle, expected, rootContext } = await openRegularFile(path, options);
  try {
    await revalidate(
      path,
      rootContext,
      options.label ?? path,
      expected,
      await handle.stat({ bigint: true }),
    );
  } finally {
    await handle.close();
  }
}
