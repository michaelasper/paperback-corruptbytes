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

  it("excludes text-record objects and arrays while preserving later structured records", () => {
    const content = [
      '{"chapter":{"id":"legacy-decoy"}}',
      '{"kind":"novel","chapter":{"id":"modern-decoy"}}',
      '{"genres":[{"slug":"text-decoy"}]}',
    ].join("\n");
    const document = parseNovelDashFlight(
      flightHtml([
        ...textRecordChunks("a", content),
        '2:{"chapter":{"id":"real"},"genres":[{"slug":"real"}]}\n',
      ]),
    );

    assert.deepEqual(extractNovelDashObject(document, '{"chapter":{'), {
      chapter: { id: "real" },
      genres: [{ slug: "real" }],
    });
    assert.throws(
      () => extractNovelDashObject(document, '{"kind":"novel","chapter":{'),
      /expected structured data/i,
    );
    assert.deepEqual(extractNovelDashArrays(document, "genres"), [[{ slug: "real" }]]);
    assert.equal(resolveNovelDashFlightString("$a", document), content);
  });

  it("resolves adjacent, empty, and Unicode text records across split pushes", () => {
    const content = 'Café 🐉\na:T1,x\n{"chapter":{"id":"text-decoy"}}';
    const stream = [
      '0:{"before":true}\n',
      ...textRecordChunks("A1", content),
      ...textRecordChunks("a2", ""),
      ...textRecordChunks("a3", "終🐉"),
      '2:{"chapter":{"content":"$a1"}}\n',
    ].join("");
    const document = parseNovelDashFlight(flightHtml(stream.split("")));

    assert.equal(resolveNovelDashFlightString("$A1", document), content);
    assert.equal(resolveNovelDashFlightString("$a2", document), "");
    assert.equal(resolveNovelDashFlightString("$a3", document), "終🐉");
    assert.equal(resolveNovelDashFlightString("$a", document), undefined);
    assert.deepEqual(extractNovelDashObject(document, '{"before":'), { before: true });
    assert.deepEqual(extractNovelDashObject(document, '{"chapter":{'), {
      chapter: { content: "$a1" },
    });
    assert.equal(
      document.stream,
      '0:{"before":true}\n' + "\0\0\0" + '2:{"chapter":{"content":"$a1"}}\n',
    );
  });

  it("does not treat mid-row header-like structured strings as text records", () => {
    const value = { chapter: { content: "a:T1,x" } };
    const document = parseNovelDashFlight(flightHtml([`1:${JSON.stringify(value)}\n`]));

    assert.deepEqual(extractNovelDashObject(document, '{"chapter":{'), value);
    assert.equal(document.textReferences.size, 0);
  });

  for (const record of [
    "a:T",
    "a:T1",
    "a:T,",
    "a:Tz,",
    "a:T-1,",
    "a:T1z,",
    "a:T20000000000000,",
    "a:T1000,short",
    "a:T1,é",
    "a:T3,🐉",
  ]) {
    it(`rejects invalid text record ${JSON.stringify(record)} before exposing reader data`, () => {
      assert.throws(
        () => parseNovelDashFlight(flightHtml([record, '\n1:{"chapter":{"id":"decoy"}}\n'])),
        /text record/i,
      );
    });
  }

  it("rejects an incomplete adjacent text header instead of exposing its payload", () => {
    assert.throws(
      () =>
        parseNovelDashFlight(
          flightHtml([...textRecordChunks("a", "complete"), 'b:Tz,{"chapter":{"id":"decoy"}}']),
        ),
      /text record/i,
    );
  });

  it("prevents JSON extraction across removed text records", () => {
    const document = parseNovelDashFlight(
      flightHtml([
        '1:{"chapter":\n',
        ...textRecordChunks("a", "discarded"),
        '{"id":"joined-decoy"}}\n2:{"genres":[\n',
        ...textRecordChunks("b", "discarded"),
        '"joined-decoy"]}\n',
      ]),
    );

    assert.throws(
      () => extractNovelDashObject(document, '{"chapter":'),
      /expected structured data/i,
    );
    assert.deepEqual(extractNovelDashArrays(document, "genres"), []);
    assert.ok(document.stream.includes('\n\0{"id"'));
    assert.ok(document.stream.includes('\n\0"joined-decoy"'));
  });

  it("rejects pages without structured flight data", () => {
    assert.throws(() => parseNovelDashFlight("<html><body>Missing</body></html>"), /data stream/i);
  });
});
