import assert from "node:assert/strict";
import { createCipheriv, createHash } from "node:crypto";
import { afterEach, beforeEach, describe, it } from "node:test";

import { ContentRating, type Chapter, type SourceManga } from "@paperback/types";
import { load } from "cheerio";

import { parseChapterDetails } from "./parsers.js";
import { decryptProtectedPages } from "./protector.js";

const originalApplication = globalThis.Application;

const md5 = (value: Uint8Array): Uint8Array => createHash("md5").update(value).digest();

const derive = (password: Uint8Array, salt: Uint8Array): { key: Uint8Array; iv: Uint8Array } => {
  const result = new Uint8Array(48);
  let previous = new Uint8Array(0);
  let offset = 0;
  while (offset < result.length) {
    const input = new Uint8Array(previous.length + password.length + salt.length);
    input.set(previous);
    input.set(password, previous.length);
    input.set(salt, previous.length + password.length);
    previous = new Uint8Array(md5(input));
    result.set(previous, offset);
    offset += previous.length;
  }
  return { key: result.slice(0, 32), iv: result.slice(32, 48) };
};

const protectorScript = (pages: string[]): string => {
  const password = "paperback-secret";
  const salt = Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7]);
  const { key, iv } = derive(new TextEncoder().encode(password), salt);
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  const plaintext = JSON.stringify(JSON.stringify(pages));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const payload = JSON.stringify({
    ct: ciphertext.toString("base64"),
    iv: Buffer.from(iv).toString("hex"),
    s: Buffer.from(salt).toString("hex"),
  }).replaceAll("/", "\\/");
  return `var harmless='ignored'; var wpmangaprotectornonce='${password}'; var chapter_data='${payload}';`;
};

beforeEach(() => {
  Object.assign(globalThis, {
    Application: {
      crypto_md5Hash: (value: string | ArrayBuffer): string =>
        createHash("md5")
          .update(typeof value === "string" ? value : Buffer.from(value))
          .digest("hex"),
      base64Decode: (value: string | ArrayBuffer): ArrayBuffer => {
        const encoded =
          typeof value === "string" ? value : new TextDecoder().decode(new Uint8Array(value));
        const bytes = Buffer.from(encoded, "base64");
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      },
      arrayBufferToUTF8String: (value: ArrayBuffer): string => new TextDecoder().decode(value),
    },
  });
});

afterEach(() => Object.assign(globalThis, { Application: originalApplication }));

describe("Madara chapter protector", () => {
  it("decrypts CryptoJS-compatible inline and data-URI payloads without evaluation", async () => {
    const pages = [
      "https://cdn.madaradex.org/manga/chapter/1.webp",
      "https://cdn.madaradex.org/manga/chapter/2.webp",
    ];
    const script = protectorScript(pages);
    const inline = load(`<script id="chapter-protector-data">${script}</script>`);
    const encoded = Buffer.from(script).toString("base64");
    const dataUri = load(
      `<script id="chapter-protector-data" src="data:text/javascript;base64,${encoded}"></script>`,
    );

    assert.deepEqual(await decryptProtectedPages(inline), pages);
    assert.deepEqual(await decryptProtectedPages(dataUri), pages);
    assert.equal(await decryptProtectedPages(load("<html></html>")), null);
  });

  it("feeds protected pages through the same URL safety and deduplication boundary", async () => {
    const sourceManga: SourceManga = {
      mangaId: "2872",
      mangaInfo: {
        primaryTitle: "Savage Hero",
        secondaryTitles: [],
        thumbnailUrl: "https://madaradex.org/cover.webp",
        synopsis: "",
        contentRating: ContentRating.ADULT,
      },
    };
    const chapter: Chapter = {
      chapterId: "chapter-2",
      sourceManga,
      langCode: "en",
      chapNum: 2,
    };
    const script = protectorScript([
      "https://cdn.madaradex.org/manga/chapter/1.webp",
      "https://cdn.madaradex.org/manga/chapter/1.webp",
      "javascript:alert(1)",
    ]);

    assert.deepEqual(
      await parseChapterDetails(`<script id="chapter-protector-data">${script}</script>`, chapter),
      {
        id: "chapter-2",
        mangaId: "2872",
        pages: ["https://cdn.madaradex.org/manga/chapter/1.webp"],
      },
    );
  });

  it("rejects malformed encrypted payloads with a source-specific error", async () => {
    const malformed = load(
      `<script id="chapter-protector-data">var wpmangaprotectornonce='x'; var chapter_data='{}';</script>`,
    );
    await assert.rejects(decryptProtectedPages(malformed), /MadaraDex chapter protector/i);
  });
});
