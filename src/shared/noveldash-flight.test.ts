import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  extractNovelDashArrays,
  extractNovelDashObject,
  parseNovelDashFlight,
  resolveNovelDashFlightString,
} from "./noveldash-flight.js";
import { flightHtml, textRecordChunks } from "./noveldash-test-fixtures.js";

describe("NovelDash Next.js flight parser", () => {
  it("reassembles UTF-8 text records split across script pushes", () => {
    const content = "<p>Café 🐉</p>";
    const html = flightHtml([
      ...textRecordChunks("a1", content),
      `2:{"chapter":{"content":"$a1","nested":{"value":"}"}}}\n`,
    ]);
    const document = parseNovelDashFlight(html);
    const value = extractNovelDashObject<{ chapter: { content: string } }>(
      document,
      '{"chapter":{',
    );

    assert.equal(resolveNovelDashFlightString(value.chapter.content, document), content);
  });

  it("extracts every complete array for a repeated key", () => {
    const document = parseNovelDashFlight(
      flightHtml([
        '1:{"genres":[{"slug":"one"}]}\n2:{"genres":[{"slug":"two"},{"slug":"three"}]}\n',
      ]),
    );

    assert.deepEqual(extractNovelDashArrays<{ slug: string }>(document, "genres"), [
      [{ slug: "one" }],
      [{ slug: "two" }, { slug: "three" }],
    ]);
  });

  it("rejects pages without structured flight data", () => {
    assert.throws(() => parseNovelDashFlight("<html><body>Missing</body></html>"), /data stream/i);
  });
});
