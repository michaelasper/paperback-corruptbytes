import assert from "node:assert/strict";
import { test } from "node:test";

import { createDeterministicRandom } from "../../scripts/random-runtime.js";
import { decodeBase64Binary } from "./runtime.js";

void test("binary base64 matches the host decoder for seeded bytes, padding and whitespace", () => {
  const random = createDeterministicRandom(0xb64_2026);
  for (let iteration = 0; iteration < 1_000; iteration += 1) {
    const bytes = Buffer.from(
      Array.from({ length: random.integer(0, 512) }, () => random.integer(0, 255)),
    );
    const encoded = bytes.toString("base64");
    for (const input of [encoded, encoded.replace(/=+$/, ""), ` \t${encoded}\n`]) {
      assert.equal(decodeBase64Binary(input), atob(input), `iteration=${iteration}`);
      assert.equal(decodeBase64Binary(input), bytes.toString("latin1"));
    }
  }
  for (const invalid of ["A", "A=", "AA=", "A===", "====", "AA==A", "A?AA", "AA\u00a0==", "💥"]) {
    assert.throws(() => decodeBase64Binary(invalid), /Invalid base64/);
  }
});
