import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  THEME_FILENAMES,
  packageThemes,
  verifyPackagedThemes,
  verifyPublishedThemes,
} from "./themes.mjs";

const sources = Object.fromEntries(
  await Promise.all(
    ["shiba.pbcolors", "dr-pepper.pbcolors"].map(async (filename) => [
      filename,
      await readFile(new URL(`../themes/${filename}`, import.meta.url), "utf8"),
    ]),
  ),
);

void test("the public inventory is exactly Shiba and Dr Pepper and cannot be mutated", () => {
  assert.deepEqual(THEME_FILENAMES, ["shiba.pbcolors", "dr-pepper.pbcolors"]);
  assert.equal(Object.isFrozen(THEME_FILENAMES), true);
});

for (const filename of ["shiba.pbcolors", "dr-pepper.pbcolors"]) {
  void describe(filename, () => {
    const source = sources[filename];
    const cli = fileURLToPath(new URL("./themes.mjs", import.meta.url));
    const exec = promisify(execFile);

    async function fixture(t, text = source) {
      const root = await mkdtemp(join(tmpdir(), "themes-"));
      t.after(() => rm(root, { recursive: true, force: true }));
      await mkdir(join(root, "themes"));
      await mkdir(join(root, "bundles"));
      for (const [name, original] of Object.entries(sources)) {
        await writeFile(join(root, "themes", name), name === filename ? text : original);
      }
      return root;
    }

    function changed(mutate) {
      const theme = JSON.parse(source);
      mutate(theme);
      return JSON.stringify(theme);
    }

    function published(root, fetchImpl, overrides = {}) {
      return verifyPublishedThemes({
        root,
        baseUrl: "https://example.com/repository",
        cacheKey: "release-sha",
        fetchImpl: (url, options) =>
          new URL(url).pathname.endsWith(`/${filename}`)
            ? fetchImpl(url, options)
            : Promise.resolve(new Response(sources[new URL(url).pathname.split("/").at(-1)])),
        ...overrides,
      });
    }

    void test("packaging preserves the authoritative bytes across repeated builds", async (t) => {
      const root = await fixture(t);
      for (let i = 0; i < 2; i++) {
        await packageThemes(root);
        const output = await readFile(join(root, "bundles", filename), "utf8");
        assert.equal(output, source);
        const theme = JSON.parse(output);
        assert.equal(Object.keys(theme).length, 20);
        assert.deepEqual(
          theme.accent.lightColor,
          filename === "shiba.pbcolors"
            ? {
                red: 156 / 255,
                green: 61 / 255,
                blue: 10 / 255,
                alpha: 1,
              }
            : { red: 112 / 255, green: 69 / 255, blue: 85 / 255, alpha: 1 },
        );
        assert.deepEqual(
          theme.background.darkColor,
          filename === "shiba.pbcolors"
            ? {
                red: 24 / 255,
                green: 20 / 255,
                blue: 17 / 255,
                alpha: 1,
              }
            : { red: 53 / 255, green: 47 / 255, blue: 50 / 255, alpha: 1 },
        );
        for (const [name, expected] of Object.entries(sources)) {
          assert.equal(await readFile(join(root, "bundles", name), "utf8"), expected);
        }
        await verifyPackagedThemes(root);
        assert.deepEqual(await readdir(join(root, "bundles")), [
          "dr-pepper.pbcolors",
          "shiba.pbcolors",
        ]);
      }
    });

    const invalidSources = [
      ["malformed", "{", /valid UTF-8 JSON/],
      ["null", "null", /PaperbackTheme20/],
      ["array", "[]", /PaperbackTheme20/],
      [
        "missing role",
        changed((x) => {
          delete x.warning;
        }),
        /PaperbackTheme20/,
      ],
      [
        "extra role",
        changed((x) => {
          x.name = "Shiba";
        }),
        /PaperbackTheme20/,
      ],
      [
        "missing mode",
        changed((x) => {
          delete x.text.darkColor;
        }),
        /text must contain exactly/,
      ],
      [
        "extra mode",
        changed((x) => {
          x.text.other = {};
        }),
        /text must contain exactly/,
      ],
      [
        "missing channel",
        changed((x) => {
          delete x.text.lightColor.red;
        }),
        /text.lightColor must contain exactly/,
      ],
      [
        "extra channel",
        changed((x) => {
          x.text.lightColor.hex = "black";
        }),
        /text.lightColor must contain exactly/,
      ],
      [
        "numeric string",
        changed((x) => {
          x.text.lightColor.red = "0";
        }),
        /text.lightColor.red must be a finite number/,
      ],
      [
        "negative",
        changed((x) => {
          x.text.lightColor.red = -0.1;
        }),
        /text.lightColor.red must be a finite number/,
      ],
      [
        "above one",
        changed((x) => {
          x.text.lightColor.red = 1.1;
        }),
        /text.lightColor.red must be a finite number/,
      ],
      [
        "infinity",
        source.replace(`"red": ${JSON.parse(source).border.lightColor.red}`, '"red": 1e999'),
        /border.lightColor.red must be a finite number/,
      ],
      [
        "translucent text",
        changed((x) => {
          x.text.lightColor.alpha = 0.5;
        }),
        /text.lightColor.alpha must be 1/,
      ],
      ["oversized", source + " ".repeat(32768), /maximum size/],
      [
        "ordinary contrast",
        changed((x) => {
          x.text.lightColor = x.background.lightColor;
        }),
        /lightColor text on background contrast/,
      ],
      [
        "badge contrast",
        changed((x) => {
          x.alertText.darkColor = x.accent.darkColor;
        }),
        /darkColor alertText on accent contrast/,
      ],
      [
        "tertiary contrast",
        changed((x) => {
          x.tertiary.lightColor = x.text.lightColor;
        }),
        /lightColor text on tertiary contrast/,
      ],
      [
        "border contrast",
        changed((x) => {
          x.border.darkColor = x.background.darkColor;
        }),
        /darkColor border on background contrast/,
      ],
      [
        "filter composition",
        changed((x) => {
          x.success.darkColor = { red: 1, green: 1, blue: 1, alpha: 1 };
        }),
        /darkColor text on success at 50% contrast/,
      ],
    ];
    for (const [name, text, error] of invalidSources) {
      void test(`packaging rejects ${name} before writing output`, async (t) => {
        const root = await fixture(t, text);
        await assert.rejects(packageThemes(root), error);
        assert.deepEqual(await readdir(join(root, "bundles")), []);
      });
    }

    void test("packaged verification rejects missing, stale, truncated and oversized files", async (t) => {
      const root = await fixture(t);
      await packageThemes(root);
      await rm(join(root, "bundles", filename));
      await assert.rejects(verifyPackagedThemes(root), /ENOENT/);
      await packageThemes(root);
      for (const text of [
        changed((x) => {
          x.overlay.darkColor.alpha = 0.2;
        }),
        "{",
        "x".repeat(32769),
      ]) {
        await writeFile(join(root, "bundles", filename), text);
        await assert.rejects(verifyPackagedThemes(root), /source bytes|maximum size/);
      }
    });

    for (const target of ["themes", `themes/${filename}`, "bundles", `bundles/${filename}`]) {
      void test(`packaging refuses a symlink at ${target} and preserves its target`, async (t) => {
        const root = await fixture(t);
        await packageThemes(root);
        const path = join(root, target);
        const outside = join(root, "sentinel");
        await rename(path, outside);
        await symlink(outside, path);
        await assert.rejects(packageThemes(root), /real directory|non-symlink/);
        const sentinel = target.includes("/") ? outside : join(outside, filename);
        assert.equal(await readFile(sentinel, "utf8"), source);
      });
    }

    void test("packaging refuses a directory in place of the artifact", async (t) => {
      const root = await fixture(t);
      await mkdir(join(root, "bundles", filename));
      await writeFile(join(root, "bundles", filename, "sentinel"), "untouched");
      await assert.rejects(packageThemes(root), /regular, non-symlink/);
      assert.equal(
        await readFile(join(root, "bundles", filename, "sentinel"), "utf8"),
        "untouched",
      );
    });

    for (const contentType of ["application/octet-stream", "text/plain"]) {
      void test(`published verification accepts exact bytes served as ${contentType}`, async (t) => {
        const root = await fixture(t);
        let requests = 0;
        await published(root, async (url, options) => {
          requests++;
          assert.equal(url, `https://example.com/repository/${filename}?release=release-sha`);
          assert.equal(options.redirect, "error");
          assert.equal(options.cache, "no-store");
          assert.equal(options.headers["cache-control"], "no-cache");
          assert.ok(options.signal instanceof AbortSignal);
          return new Response(source, { headers: { "content-type": contentType } });
        });
        assert.equal(requests, 1);
      });
    }

    for (const [name, response, error] of [
      ["404", () => new Response("missing", { status: 404 }), /HTTP 404/],
      ["redirect", () => new Response(null, { status: 302 }), /HTTP 302/],
      ["HTML fallback", () => new Response("<!doctype html>"), /valid UTF-8 JSON/],
      ["invalid schema", () => new Response("{}"), /PaperbackTheme20/],
      [
        "stale colors",
        () =>
          new Response(
            changed((x) => {
              x.overlay.lightColor.alpha = 0.2;
            }),
          ),
        /source bytes/,
      ],
      ["different formatting", () => new Response(source + "\n"), /source bytes/],
      ["empty body", () => new Response(null), /no response body/],
    ]) {
      void test(`published verification rejects ${String(name)}`, async (t) => {
        const root = await fixture(t);
        await assert.rejects(
          published(root, async () => response()),
          error,
        );
      });
    }

    for (const declared of [false, true]) {
      void test(`published verification cancels ${declared ? "declared" : "streamed"} oversized bodies`, async (t) => {
        const root = await fixture(t);
        let cancelled = false;
        const body = new ReadableStream({
          pull(controller) {
            controller.enqueue(new Uint8Array(8192));
          },
          cancel() {
            cancelled = true;
          },
        });
        await assert.rejects(
          published(
            root,
            async () =>
              new Response(body, {
                headers: declared ? { "content-length": "32769" } : {},
              }),
          ),
          /maximum size/,
        );
        assert.equal(cancelled, true);
      });
    }

    void test("published verification times out a stalled request", async (t) => {
      const root = await fixture(t);
      const keepAlive = setInterval(() => {}, 100);
      try {
        await assert.rejects(
          published(
            root,
            async (_url, { signal }) =>
              new Promise((_resolve, reject) => {
                signal.addEventListener("abort", () => reject(signal.reason), { once: true });
              }),
            { timeoutMs: 10 },
          ),
          /timeout/i,
        );
      } finally {
        clearInterval(keepAlive);
      }
    });

    void test("published verification rejects unsafe base URLs before fetching", async (t) => {
      const root = await fixture(t);
      for (const baseUrl of [
        "http://example.com",
        "https://user:pass@example.com",
        "https://example.com/?x=1",
        "https://example.com/#x",
      ]) {
        await assert.rejects(
          published(root, () => assert.fail("unexpected fetch"), { baseUrl }),
          /plain HTTPS/,
        );
      }
      await assert.rejects(
        published(root, () => assert.fail("unexpected fetch"), { cacheKey: "" }),
        /cache key/,
      );
    });

    void test("CLI packages a file and reports invalid commands and invalid input", async (t) => {
      const root = await fixture(t);
      const { stdout } = await exec(process.execPath, [cli, "package"], { cwd: root });
      assert.match(stdout, /Packaged shiba.pbcolors, dr-pepper.pbcolors/);
      assert.equal(await readFile(join(root, "bundles", filename), "utf8"), source);
      await assert.rejects(exec(process.execPath, [cli, "unknown"], { cwd: root }), (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /Usage/);
        return true;
      });
      await writeFile(join(root, "themes", filename), "{}");
      await assert.rejects(exec(process.execPath, [cli, "package"], { cwd: root }), (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /PaperbackTheme20/);
        return true;
      });
      assert.equal(await readFile(join(root, "bundles", filename), "utf8"), source);
    });

    void test("published verification times out while reading a stalled body", async (t) => {
      const root = await fixture(t);
      const keepAlive = setInterval(() => {}, 100);
      try {
        await assert.rejects(
          published(
            root,
            async (_url, { signal }) =>
              new Response(
                new ReadableStream({
                  start(controller) {
                    controller.enqueue(new TextEncoder().encode("{"));
                    signal.addEventListener("abort", () => controller.error(signal.reason), {
                      once: true,
                    });
                  },
                }),
              ),
            { timeoutMs: 10 },
          ),
          /timeout/i,
        );
      } finally {
        clearInterval(keepAlive);
      }
    });

    void test("published verification refuses redirected success responses", async (t) => {
      const root = await fixture(t);
      await assert.rejects(
        published(root, async () => {
          const response = new Response(source);
          Object.defineProperty(response, "redirected", { value: true });
          return response;
        }),
        /redirect/,
      );
    });

    void test("packaging rejects invalid UTF-8 instead of rewriting its bytes", async (t) => {
      const root = await fixture(t);
      await writeFile(
        join(root, "themes", filename),
        Buffer.concat([Buffer.from(source), Buffer.from([0xff])]),
      );
      await assert.rejects(packageThemes(root), /valid UTF-8 JSON/);
      assert.deepEqual(await readdir(join(root, "bundles")), []);
    });

    void test("a missing source prevents any output writes", async (t) => {
      const root = await fixture(t);
      await rm(join(root, "themes", filename));
      await assert.rejects(packageThemes(root), /ENOENT/);
      assert.deepEqual(await readdir(join(root, "bundles")), []);
    });

    void test("invalid input preserves both existing packaged files", async (t) => {
      const root = await fixture(t);
      await packageThemes(root);
      await writeFile(join(root, "themes", filename), "{}");
      await assert.rejects(packageThemes(root), /PaperbackTheme20/);
      for (const [name, expected] of Object.entries(sources)) {
        assert.equal(await readFile(join(root, "bundles", name), "utf8"), expected);
      }
    });
  });
}

void test("published verification requests both exact public artifacts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "published-themes-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "themes"));
  for (const [name, text] of Object.entries(sources))
    await writeFile(join(root, "themes", name), text);
  const urls = [];
  await verifyPublishedThemes({
    root,
    baseUrl: "https://example.com/repository/",
    cacheKey: "release-sha",
    fetchImpl: async (url) => {
      urls.push(url);
      return new Response(sources[new URL(url).pathname.split("/").at(-1)]);
    },
  });
  assert.deepEqual(urls, [
    "https://example.com/repository/shiba.pbcolors?release=release-sha",
    "https://example.com/repository/dr-pepper.pbcolors?release=release-sha",
  ]);
});
