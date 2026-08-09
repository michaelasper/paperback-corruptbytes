import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ContentRating } from "@paperback/types";

import { contentRatingForTags, plainTextFromHtml, sanitizeChapterHtml } from "./html.js";

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

  it("assigns conservative per-title ratings from tags", () => {
    assert.equal(contentRatingForTags(["Action", "Romance"]), ContentRating.EVERYONE);
    assert.equal(contentRatingForTags(["Action", "Gore"]), ContentRating.MATURE);
    assert.equal(contentRatingForTags(["Adult", "Drama"]), ContentRating.ADULT);
  });
});
