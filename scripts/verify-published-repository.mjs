import { lstat, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { assertPinnedDirectory, pinSafeDirectory, readSafeFile } from "./safe-files.mjs";
import { compareSourceIds, extractExtensionInfo, PB_CONFIG_MAX_BYTES } from "./version-utils.mjs";

const MANIFEST_MAX_BYTES = 4 * 1024 * 1024;
const INFO_MAX_BYTES = 256 * 1024;
const BUNDLE_MAX_BYTES = 16 * 1024 * 1024;
const ICON_MAX_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 20_000;
const ARTIFACT_CONCURRENCY = 4;

const discoverSources = async (root) => {
  const sourceRoot = join(root, "src");
  const sourceRootContext = await pinSafeDirectory(sourceRoot, "src");
  const entries = await readdir(sourceRoot, { withFileTypes: true });
  await assertPinnedDirectory(sourceRootContext);
  const sources = [];
  for (const entry of entries) {
    const entryPath = join(sourceRoot, entry.name);
    const entryStats = await lstat(entryPath);
    if (entryStats.isSymbolicLink()) {
      throw new Error(`src/${entry.name} must not be a symbolic link.`);
    }
    if (!entryStats.isDirectory()) continue;
    try {
      const configStats = await lstat(join(entryPath, "pbconfig.ts"));
      if (!configStats.isFile() || configStats.isSymbolicLink()) {
        throw new Error(`src/${entry.name}/pbconfig.ts must be a regular file.`);
      }
      const configText = await readSafeFile(join(entryPath, "pbconfig.ts"), {
        rootPath: sourceRootContext,
        label: `${entry.name}/pbconfig.ts`,
        maxBytes: PB_CONFIG_MAX_BYTES,
      });
      const metadata = extractExtensionInfo(configText, `${entry.name}/pbconfig.ts`);
      sources.push(JSON.parse(JSON.stringify({ ...metadata, id: entry.name })));
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ENOENT") continue;
      throw error;
    }
  }
  await assertPinnedDirectory(sourceRootContext);
  return sources.sort((left, right) => compareSourceIds(left.id, right.id));
};

const publishedBaseUrl = (value) => {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Published repository URL is invalid.");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("Published repository URL must be a plain HTTPS URL.");
  }
  parsed.pathname = `${parsed.pathname.replace(/\/+$/, "")}/`;
  return parsed;
};

const artifactUrl = (baseUrl, relativePath, cacheKey) => {
  const url = new URL(relativePath, baseUrl);
  url.searchParams.set("release", cacheKey);
  return url;
};

const responseBytes = async ({ fetchImpl, url, maxBytes, timeoutMs }) => {
  const response = await fetchImpl(url.toString(), {
    cache: "no-store",
    headers: { "cache-control": "no-cache" },
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`${url.pathname} returned HTTP ${response.status}.`);

  const finalUrl = new URL(response.url);
  if (finalUrl.origin !== url.origin) {
    throw new Error(`${url.pathname} redirected outside the published repository origin.`);
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error(`${url.pathname} exceeds its published artifact size limit.`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0) throw new Error(`${url.pathname} is empty.`);
  if (bytes.byteLength > maxBytes) {
    throw new Error(`${url.pathname} exceeds its published artifact size limit.`);
  }
  return { bytes, contentType: response.headers.get("content-type") ?? "" };
};

const responseJson = async (options) => {
  const { bytes, contentType } = await responseBytes(options);
  if (!/application\/(?:[\w.+-]+\+)?json/i.test(contentType)) {
    throw new Error(`${options.url.pathname} is not served as JSON.`);
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error(`${options.url.pathname} is not valid JSON.`);
  }
};

const runBounded = async (tasks, concurrency) => {
  const results = Array.from({ length: tasks.length });
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < tasks.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await tasks[index]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker()));
  return results;
};

export const verifyPublishedRepository = async ({
  baseUrl,
  cacheKey,
  fetchImpl = globalThis.fetch,
  root = process.cwd(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) => {
  if (typeof fetchImpl !== "function") throw new Error("A fetch implementation is required.");
  if (typeof cacheKey !== "string" || !cacheKey.trim()) {
    throw new Error("A non-empty published release cache key is required.");
  }
  const base = publishedBaseUrl(baseUrl);
  const expectedSources = await discoverSources(root);
  const sourceIds = expectedSources.map((source) => source.id);
  const manifestUrl = artifactUrl(base, "versioning.json", cacheKey);
  const manifest = await responseJson({
    fetchImpl,
    maxBytes: MANIFEST_MAX_BYTES,
    timeoutMs,
    url: manifestUrl,
  });
  if (!manifest || typeof manifest !== "object" || !Array.isArray(manifest.sources)) {
    throw new Error("Published versioning.json does not contain a sources array.");
  }

  const publishedIds = manifest.sources.map((source) => source?.id);
  if (publishedIds.some((id) => typeof id !== "string")) {
    throw new Error("Published versioning.json contains an invalid source ID.");
  }
  const uniquePublishedIds = [...new Set(publishedIds)].sort(compareSourceIds);
  const missing = sourceIds.filter((id) => !uniquePublishedIds.includes(id));
  const unexpected = uniquePublishedIds.filter((id) => !sourceIds.includes(id));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `Published repository source mismatch: missing [${missing.join(", ")}], unexpected [${unexpected.join(", ")}].`,
    );
  }

  for (const expected of expectedSources) {
    const listed = manifest.sources.find((source) => source.id === expected.id);
    if (!isDeepStrictEqual(listed, expected)) {
      throw new Error(`${expected.id} published metadata is stale compared with pbconfig.ts.`);
    }
  }

  const tasks = sourceIds.flatMap((id) => {
    const listed = manifest.sources.find((source) => source.id === id);
    if (!listed || typeof listed.icon !== "string" || !listed.icon) {
      throw new Error(`Published metadata for ${id} does not declare an icon.`);
    }
    const encodedId = encodeURIComponent(id);
    return [
      async () => {
        const url = artifactUrl(base, `${encodedId}/info.json`, cacheKey);
        const info = await responseJson({ fetchImpl, maxBytes: INFO_MAX_BYTES, timeoutMs, url });
        if (!isDeepStrictEqual(info, listed)) {
          throw new Error(`${id}/info.json does not match published versioning.json.`);
        }
      },
      async () => {
        const url = artifactUrl(base, `${encodedId}/index.js`, cacheKey);
        const { contentType } = await responseBytes({
          fetchImpl,
          maxBytes: BUNDLE_MAX_BYTES,
          timeoutMs,
          url,
        });
        if (!/(?:java|ecma)script/i.test(contentType)) {
          throw new Error(`${id}/index.js is not served as JavaScript.`);
        }
      },
      async () => {
        const icon = listed.icon
          .split("/")
          .map((component) => encodeURIComponent(component))
          .join("/");
        const url = artifactUrl(base, `${encodedId}/static/${icon}`, cacheKey);
        const { contentType } = await responseBytes({
          fetchImpl,
          maxBytes: ICON_MAX_BYTES,
          timeoutMs,
          url,
        });
        if (!/^image\//i.test(contentType)) {
          throw new Error(`${id} icon is not served as an image.`);
        }
      },
    ];
  });
  await runBounded(tasks, ARTIFACT_CONCURRENCY);
  return { artifactCount: tasks.length, sourceIds };
};

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const baseUrl = process.env.PUBLISHED_REPOSITORY_URL;
  const cacheKey = process.env.PUBLISHED_RELEASE_KEY;
  if (!baseUrl || !cacheKey) {
    console.error("PUBLISHED_REPOSITORY_URL and PUBLISHED_RELEASE_KEY are required.");
    process.exitCode = 1;
  } else {
    try {
      const result = await verifyPublishedRepository({ baseUrl, cacheKey });
      console.log(
        `Verified ${result.sourceIds.length} published sources and ${result.artifactCount} artifacts.`,
      );
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}
