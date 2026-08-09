import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ContentRating } from "@paperback/types";

import {
  contentRatingForTags,
  paragraphsToXhtml,
  plainTextFromHtml,
  sanitizeChapterHtml,
} from "./html.js";

describe("shared HTML engine", () => {
  it("sanitizes novel HTML and resolves safe relative resources", () => {
    const html = sanitizeChapterHtml(
      `
        <script>alert("x")</script>
        <style>body { display: none }</style>
        <p style="color:red" onclick="steal()">First<br>line</p>
        <a href="/series/next" onmouseover="steal()">Next</a>
        <img src="../images/page 1.webp" srcset="evil 2x">
        <img src="http://cdn.example/insecure.webp">
        <a href="http://reader.example/insecure">insecure</a>
        <a href="javascript:steal()">unsafe</a>
        <iframe src="https://evil.example"></iframe>
        <form action="https://evil.example"><input name="secret"></form>
      `,
      "https://reader.example/chapters/one/",
    );

    assert.match(html, /^<html xmlns="http:\/\/www\.w3\.org\/1999\/xhtml"><head><\/head><body>/);
    assert.match(html, /<p>First<br>line<\/p>/);
    assert.match(html, /href="https:\/\/reader\.example\/series\/next"/);
    assert.match(html, /src="https:\/\/reader\.example\/chapters\/images\/page%201\.webp"/);
    assert.doesNotMatch(
      html,
      /script|style=|onclick|onmouseover|srcset|javascript:|iframe|form|input/i,
    );
    assert.doesNotMatch(html, /http:\/\/cdn\.example|http:\/\/reader\.example/);
  });

  it("turns rich descriptions into readable text without merging blocks", () => {
    assert.equal(
      plainTextFromHtml("<h2>Synopsis</h2><p>First &amp; second<br>line</p><p>Final.</p>"),
      "Synopsis\n\nFirst & second\nline\n\nFinal.",
    );
  });

  it("renders API paragraph text as inert, valid XHTML", () => {
    const html = paragraphsToXhtml([
      "A <script>alert('no')</script> & B",
      "Line one\nLine two",
      "  ",
      "‘Quoted’ text",
    ]);

    assert.equal(
      html,
      '<html xmlns="http://www.w3.org/1999/xhtml"><head></head><body>' +
        "<p>A &lt;script&gt;alert(&apos;no&apos;)&lt;/script&gt; &amp; B</p>" +
        "<p>Line one<br />Line two</p>" +
        "<p>‘Quoted’ text</p>" +
        "</body></html>",
    );
    assert.doesNotMatch(html, /<script>/i);
  });

  it("removes XML-invalid code points without damaging Unicode text", () => {
    const html = paragraphsToXhtml([`A\u0000B\u0008C\tD 😀 ${String.fromCharCode(0xd800)}`]);

    assert.match(html, /<p>ABC\tD 😀 <\/p>/);
    assert.equal(
      html.split("").some((character) => {
        const code = character.charCodeAt(0);
        return code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d;
      }),
      false,
    );
    assert.equal(html.includes(String.fromCharCode(0xd800)), false);
  });

  it("drops XML controls, noncharacters, and lone surrogates while preserving text", () => {
    const c1Controls = String.fromCodePoint(
      ...Array.from({ length: 0x20 }, (_, index) => 0x80 + index),
    );
    const invalid = [
      "\u0000",
      "\u000b",
      "\u007f",
      c1Controls,
      String.fromCodePoint(0xfdd0, 0xfdef),
      String.fromCodePoint(0xfffe, 0xffff, 0x1fffe, 0x1ffff, 0x10fffe, 0x10ffff),
      "\ud800x\udfff",
    ].join("");

    const html = paragraphsToXhtml([`tab\tline\nnext\rreturn 😀${invalid}tail`]);

    assert.equal(
      html,
      '<html xmlns="http://www.w3.org/1999/xhtml"><head></head><body>' +
        "<p>tab\tline<br />next\rreturn 😀xtail</p>" +
        "</body></html>",
    );
  });

  it("applies XML code-point safety to sanitized HTML readers too", () => {
    const invalid = `\u0000\u007f${String.fromCodePoint(0xfdd0, 0xffff)}\ud800`;
    const html = sanitizeChapterHtml(
      `<p title="safe${invalid}title">before${invalid}after 😀</p>`,
      "https://reader.example/chapter/",
    );

    // parse5 replaces NUL with U+FFFD before serialization; the replacement
    // is valid XML, while every still-invalid code point must be removed.
    assert.match(html, /<p title="safe�title">beforeafter 😀<\/p>/);
    for (const character of html) {
      const codePoint = character.codePointAt(0)!;
      assert.equal(
        codePoint === 0x7f ||
          (codePoint >= 0x80 && codePoint <= 0x9f) ||
          (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
          (codePoint >= 0xfdd0 && codePoint <= 0xfdef) ||
          (codePoint & 0xffff) >= 0xfffe,
        false,
      );
    }
  });

  it("assigns conservative per-title ratings from tags", () => {
    assert.equal(contentRatingForTags(["Action", "Romance"]), ContentRating.EVERYONE);
    assert.equal(contentRatingForTags(["Action", "Gore"]), ContentRating.MATURE);
    assert.equal(contentRatingForTags(["Adult", "Drama"]), ContentRating.ADULT);
  });
});
