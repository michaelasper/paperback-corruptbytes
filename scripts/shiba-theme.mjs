import { randomUUID } from "node:crypto";
import { lstat, open, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  assertPinnedDirectory,
  assertSafeRegularFile,
  pinSafeDirectory,
  readSafeFile,
} from "./safe-files.mjs";

export const SHIBA_FILENAME = "shiba.pbcolors";
const MAX_BYTES = 32 * 1024;
const ROLES = [
  "border",
  "foreground",
  "tertiaryText",
  "accent",
  "primaryText",
  "tertiary",
  "text",
  "textTertiary",
  "alert",
  "overlay",
  "primary",
  "separator",
  "secondary",
  "textSecondary",
  "alertText",
  "warning",
  "error",
  "secondaryText",
  "success",
  "background",
];

const MODES = ["lightColor", "darkColor"];
const CHANNELS = ["red", "green", "blue", "alpha"];

function exactKeys(value, keys, label) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new Error(`${label} must contain exactly ${keys.join(", ")}.`);
  }
}

function luminance(color) {
  return [color.red, color.green, color.blue].reduce((sum, channel, index) => {
    const linear = channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    return sum + linear * [0.2126, 0.7152, 0.0722][index];
  }, 0);
}

function composite(color, background, opacity) {
  const alpha = color.alpha * opacity;
  return Object.fromEntries([
    ...["red", "green", "blue"].map((key) => [
      key,
      color[key] * alpha + background[key] * (1 - alpha),
    ]),
    ["alpha", 1],
  ]);
}

function assertReadablePairs(theme) {
  for (const mode of MODES) {
    const colors = Object.fromEntries(ROLES.map((role) => [role, theme[role][mode]]));
    const gray = (mode === "lightColor" ? 217 : 41) / 255;
    colors.material = { red: gray, green: gray, blue: gray, alpha: 1 };
    colors.description = composite(colors.foreground, colors.material, 0.5);
    const check = (foreground, background, minimum, fill = colors[background]) => {
      const a = luminance(composite(colors[foreground], fill, 1));
      const b = luminance(fill);
      const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      if (ratio < minimum) {
        throw new Error(
          `${mode} ${foreground} on ${background} contrast ${ratio.toFixed(2)} is below ${minimum}.`,
        );
      }
    };
    for (const text of ["text", "textSecondary", "textTertiary", "accent"]) {
      for (const fill of ["background", "foreground", "tertiary", "material", "description"]) {
        check(text, fill, 4.5);
      }
    }
    for (const [text, fill] of [
      ["primaryText", "primary"],
      ["secondaryText", "secondary"],
      ["tertiaryText", "tertiary"],
      ["alertText", "accent"],
      ["alertText", "alert"],
    ])
      check(text, fill, 4.5);
    for (const fill of ["success", "error"]) {
      check("text", `${fill} at 50%`, 4.5, composite(colors[fill], colors.background, 0.5));
      check("text", fill, 4.5);
    }
    for (const fill of ["background", "foreground"]) check("border", fill, 3);
  }
}

function parseTheme(text, label) {
  let theme;
  try {
    if (text.includes("\uFFFD")) throw new Error("Invalid UTF-8");
    theme = JSON.parse(text);
  } catch {
    throw new Error(`${label} must contain valid UTF-8 JSON.`);
  }
  exactKeys(theme, ROLES, `${label} ShibaTheme20`);
  for (const role of ROLES) {
    exactKeys(theme[role], MODES, role);
    for (const mode of MODES) {
      const color = theme[role][mode];
      exactKeys(color, CHANNELS, `${role}.${mode}`);
      for (const channel of CHANNELS) {
        const value = color[channel];
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
          throw new Error(`${role}.${mode}.${channel} must be a finite number in [0, 1].`);
        }
      }
      if (role !== "overlay" && color.alpha !== 1) {
        throw new Error(`${role}.${mode}.alpha must be 1 for supported contrast checks.`);
      }
    }
  }
  assertReadablePairs(theme);
  return theme;
}

async function sourceTheme(root) {
  const directory = await pinSafeDirectory(join(root, "themes"), "themes");
  const text = await readSafeFile(join(directory.path, SHIBA_FILENAME), {
    rootPath: directory,
    maxBytes: MAX_BYTES,
    label: `themes/${SHIBA_FILENAME}`,
  });
  parseTheme(text, `themes/${SHIBA_FILENAME}`);
  return text;
}

async function assertDestination(path, directory) {
  try {
    await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  await assertSafeRegularFile(path, { rootPath: directory });
}

export async function packageShibaTheme(root = process.cwd()) {
  const text = await sourceTheme(root);
  const directory = await pinSafeDirectory(join(root, "bundles"), "bundles");
  const destination = join(directory.path, SHIBA_FILENAME);
  await assertDestination(destination, directory);
  const temporary = join(directory.path, `.shiba-${randomUUID()}.tmp`);
  await assertPinnedDirectory(directory);
  const handle = await open(temporary, "wx", 0o644);
  try {
    await assertPinnedDirectory(directory);
    await handle.writeFile(text, "utf8");
    await handle.close();
    await assertDestination(destination, directory);
    await assertPinnedDirectory(directory);
    await rename(temporary, destination);
    await assertPinnedDirectory(directory);
  } finally {
    await handle.close();
    await assertPinnedDirectory(directory);
    await rm(temporary, { force: true });
  }
}

export async function verifyPackagedShibaTheme(root = process.cwd()) {
  const expected = await sourceTheme(root);
  const directory = await pinSafeDirectory(join(root, "bundles"), "bundles");
  const actual = await readSafeFile(join(directory.path, SHIBA_FILENAME), {
    rootPath: directory,
    maxBytes: MAX_BYTES,
    label: `bundles/${SHIBA_FILENAME}`,
  });
  if (actual !== expected)
    throw new Error(`bundles/${SHIBA_FILENAME} differs from the source bytes.`);
}

export async function verifyPublishedShibaTheme({
  root = process.cwd(),
  baseUrl,
  cacheKey,
  fetchImpl = globalThis.fetch,
  timeoutMs = 20_000,
}) {
  const base = new URL(baseUrl);
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) {
    throw new Error("Published repository URL must be a plain HTTPS URL.");
  }
  if (typeof cacheKey !== "string" || !cacheKey.trim()) {
    throw new Error("A non-empty published release cache key is required.");
  }
  base.pathname = `${base.pathname.replace(/\/+$/, "")}/`;
  const url = new URL(SHIBA_FILENAME, base);
  url.searchParams.set("release", cacheKey);
  const expected = Buffer.from(await sourceTheme(root), "utf8");
  const response = await fetchImpl(url.toString(), {
    cache: "no-store",
    headers: { "cache-control": "no-cache" },
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok || response.redirected) {
    await response.body?.cancel();
    throw new Error(`${SHIBA_FILENAME} returned HTTP ${response.status} or a redirect.`);
  }
  if (Number(response.headers.get("content-length")) > MAX_BYTES) {
    await response.body?.cancel();
    throw new Error(`${SHIBA_FILENAME} exceeds maximum size of ${MAX_BYTES} bytes.`);
  }
  if (!response.body) throw new Error(`${SHIBA_FILENAME} has no response body.`);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BYTES)
        throw new Error(`${SHIBA_FILENAME} exceeds maximum size of ${MAX_BYTES} bytes.`);
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  const actual = Buffer.concat(chunks, total);
  parseTheme(actual.toString("utf8"), `Published ${SHIBA_FILENAME}`);
  if (!actual.equals(expected))
    throw new Error(`Published ${SHIBA_FILENAME} differs from the source bytes.`);
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  try {
    const command = process.argv[2];
    if (process.argv.length !== 3)
      throw new Error("Usage: shiba-theme.mjs package|verify-published");
    if (command === "package") {
      await packageShibaTheme();
      console.log(`Packaged ${SHIBA_FILENAME}.`);
    } else if (command === "verify-published") {
      await verifyPublishedShibaTheme({
        baseUrl: process.env.PUBLISHED_REPOSITORY_URL,
        cacheKey: process.env.PUBLISHED_RELEASE_KEY,
      });
      console.log(`Verified published ${SHIBA_FILENAME}.`);
    } else {
      throw new Error("Usage: shiba-theme.mjs package|verify-published");
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
