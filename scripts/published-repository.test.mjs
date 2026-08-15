import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { verifyPublishedRepository } from "./verify-published-repository.mjs";

const temporaryRoots = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })));
});

const sourceInfo = (id, version = "1.0.0") => ({
  badges: [],
  capabilities: [],
  contentRating: "MATURE",
  description: `${id} test source`,
  developers: [{ name: "Test" }],
  icon: "icon.png",
  id,
  language: "en",
  name: id,
  version,
});

const sourceRoot = async (versions) => {
  const root = await mkdtemp(join(tmpdir(), "paperback-published-"));
  temporaryRoots.push(root);
  for (const [id, version] of Object.entries(versions)) {
    await mkdir(join(root, "src", id), { recursive: true });
    const info = sourceInfo(id, version);
    const { id: _, ...config } = info;
    await writeFile(
      join(root, "src", id, "pbconfig.ts"),
      `export default ${JSON.stringify(config)};\n`,
    );
  }
  return root;
};

const response = (url, body, contentType) => ({
  ok: true,
  status: 200,
  url,
  headers: new Headers({
    "content-length": String(Buffer.byteLength(body)),
    "content-type": contentType,
  }),
  arrayBuffer: async () => {
    const bytes = Buffer.from(body);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  },
});

const publishedFetch = (versions, requested) => async (input) => {
  const url = String(input);
  requested.push(url);
  const parsed = new URL(url);
  const pathname = parsed.pathname.replace("/repo/", "");
  const sources = Object.entries(versions).map(([id, version]) => sourceInfo(id, version));
  if (pathname === "versioning.json") {
    return response(
      url,
      JSON.stringify({ repository: { name: "Repo" }, sources }),
      "application/json",
    );
  }
  const match = pathname.match(/^([^/]+)\/(info\.json|index\.js|static\/icon\.png)$/);
  if (!match?.[1] || !match[2]) throw new Error(`Unexpected URL: ${url}`);
  if (match[2] === "info.json") {
    const info = sources.find((source) => source.id === match[1]);
    return response(url, JSON.stringify(info), "application/json");
  }
  if (match[2] === "index.js") return response(url, "var source = {};", "application/javascript");
  return response(url, "png", "image/png");
};

describe("published Paperback repository verification", () => {
  it("proves every local source is in the cache-busted manifest with reachable artifacts", async () => {
    const root = await sourceRoot({ Alpha: "1.0.0", Beta: "1.0.0" });
    const requested = [];

    const result = await verifyPublishedRepository({
      baseUrl: "https://example.test/repo/",
      cacheKey: "release-sha",
      fetchImpl: publishedFetch({ Alpha: "1.0.0", Beta: "1.0.0" }, requested),
      root,
    });

    assert.deepEqual(result.sourceIds, ["Alpha", "Beta"]);
    assert.equal(result.artifactCount, 6);
    assert.equal(requested.length, 7);
    assert.ok(requested.every((url) => url.endsWith("?release=release-sha")));
  });

  it("rejects a successful deployment whose manifest silently omits a new source", async () => {
    const root = await sourceRoot({ Alpha: "1.0.0", Beta: "1.0.0" });

    await assert.rejects(
      verifyPublishedRepository({
        baseUrl: "https://example.test/repo/",
        cacheKey: "release-sha",
        fetchImpl: publishedFetch({ Alpha: "1.0.0" }, []),
        root,
      }),
      /missing.*Beta/i,
    );
  });

  it("rejects stale published metadata even when every source ID is present", async () => {
    const root = await sourceRoot({ Alpha: "1.0.1" });

    await assert.rejects(
      verifyPublishedRepository({
        baseUrl: "https://example.test/repo/",
        cacheKey: "release-sha",
        fetchImpl: publishedFetch({ Alpha: "1.0.0" }, []),
        root,
      }),
      /Alpha.*stale|stale.*Alpha/i,
    );
  });
});
