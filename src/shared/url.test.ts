import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  isHttpsUrlForDomain,
  isHttpsUrlForHosts,
  resolveHttpsUrl,
  resolveHttpUrl,
  urlPathSlug,
} from "./url.js";

const originalURL = globalThis.URL;

afterEach(() => {
  Object.assign(globalThis, { URL: originalURL });
});

describe("shared URL engine", () => {
  it("resolves every HTTP URL shape emitted by source sites", () => {
    const base = "https://reader.example/series/title/";

    assert.equal(
      resolveHttpUrl("https://cdn.example/page 1.webp", base),
      "https://cdn.example/page%201.webp",
    );
    assert.equal(resolveHttpUrl("//cdn.example/page.webp", base), "https://cdn.example/page.webp");
    assert.equal(
      resolveHttpUrl("/covers/title.webp", base),
      "https://reader.example/covers/title.webp",
    );
    assert.equal(
      resolveHttpUrl("../page.webp?size=large#reader", base),
      "https://reader.example/series/page.webp?size=large#reader",
    );
    assert.equal(
      resolveHttpUrl("?quality=high", "https://reader.example/chapter/1"),
      "https://reader.example/chapter/1?quality=high",
    );
    assert.equal(
      resolveHttpUrl("#reader", "https://reader.example/chapter/1?quality=high#old"),
      "https://reader.example/chapter/1?quality=high#reader",
    );
  });

  it("rejects empty, malformed, credentialed, and non-HTTP URLs", () => {
    const base = "https://reader.example/";

    for (const value of [
      undefined,
      null,
      "",
      "javascript:alert(1)",
      "data:image/png;base64,abc",
      "file:///tmp/page.png",
      "https://user:secret@reader.example/page.jpg",
      "http://",
      "not a URL",
    ]) {
      assert.equal(resolveHttpUrl(value, base), undefined);
    }
  });

  it("can require encrypted transport for remote reader resources", () => {
    const base = "https://reader.example/chapter/1/";

    assert.equal(resolveHttpsUrl("/page.webp", base), "https://reader.example/page.webp");
    assert.equal(
      resolveHttpsUrl("https://cdn.example/page.webp", base),
      "https://cdn.example/page.webp",
    );
    assert.equal(resolveHttpsUrl("http://cdn.example/page.webp", base), undefined);
  });

  it("does not depend on the browser URL global missing from Paperback", () => {
    Object.assign(globalThis, { URL: undefined });

    assert.equal(
      resolveHttpUrl("/page.webp", "https://reader.example/chapter/1/"),
      "https://reader.example/page.webp",
    );
    assert.equal(urlPathSlug("https://reader.example/comics/a-title/?ref=home"), "a-title");
  });

  it("scopes trusted HTTPS requests to explicit hosts", () => {
    const hosts = new Set(["reader.example", "api.reader.example"]);

    assert.equal(isHttpsUrlForHosts("https://reader.example/", hosts), true);
    assert.equal(isHttpsUrlForHosts("https://api.reader.example/v1", hosts), true);
    assert.equal(isHttpsUrlForHosts("https://reader.example:443/", hosts), true);
    assert.equal(isHttpsUrlForHosts("https://reader.example:444/", hosts), false);
    assert.equal(isHttpsUrlForHosts("https://cdn.reader.example/page", hosts), false);
    assert.equal(isHttpsUrlForHosts("http://reader.example/", hosts), false);
    assert.equal(isHttpsUrlForHosts("https://reader.example.evil.test/", hosts), false);
  });

  it("can scope a source to its apex domain and real subdomains", () => {
    assert.equal(isHttpsUrlForDomain("https://reader.example/", "reader.example"), true);
    assert.equal(isHttpsUrlForDomain("https://reader.example:443/", "reader.example"), true);
    assert.equal(isHttpsUrlForDomain("https://reader.example:444/", "reader.example"), false);
    assert.equal(isHttpsUrlForDomain("https://cdn.reader.example/page", "reader.example"), true);
    assert.equal(isHttpsUrlForDomain("http://reader.example/", "reader.example"), false);
    assert.equal(isHttpsUrlForDomain("https://reader.example.evil.test/", "reader.example"), false);
    assert.equal(isHttpsUrlForDomain("https://notreader.example/", "reader.example"), false);
  });

  it("extracts only a decoded final path segment", () => {
    assert.equal(urlPathSlug("https://reader.example/comics/a%20title/"), "a title");
    assert.equal(urlPathSlug("https://reader.example/"), undefined);
    assert.equal(urlPathSlug("not a url"), undefined);
  });
});
