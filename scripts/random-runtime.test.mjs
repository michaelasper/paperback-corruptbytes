import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createDeterministicRandom,
  deriveDeterministicSeed,
  runBoundedTasks,
} from "./random-runtime.js";

describe("deterministic random probe runtime", () => {
  it("gives each source a stable random stream independent of scheduling order", () => {
    const forward = ["Atsumaru", "Diva", "Valir"].map((name) => {
      const random = createDeterministicRandom(deriveDeterministicSeed(42, name));
      return [name, random.integer(1, 1_000), random.integer(1, 1_000)];
    });
    const reverse = ["Valir", "Diva", "Atsumaru"]
      .map((name) => {
        const random = createDeterministicRandom(deriveDeterministicSeed(42, name));
        return [name, random.integer(1, 1_000), random.integer(1, 1_000)];
      })
      .reverse();

    assert.deepEqual(reverse, forward);
  });

  it("runs jobs within a fixed concurrency budget and retains input ordering", async () => {
    let active = 0;
    let maximumActive = 0;
    const tasks = [18, 3, 9, 1].map((duration, index) => async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, duration));
      active -= 1;
      if (index === 1) throw new Error("isolated failure");
      return index;
    });

    const results = await runBoundedTasks(tasks, 2);

    assert.equal(maximumActive, 2);
    assert.deepEqual(
      results.map((result) =>
        result.status === "fulfilled" ? result.value : result.reason.message,
      ),
      [0, "isolated failure", 2, 3],
    );
  });

  it("rejects invalid worker budgets before scheduling work", async () => {
    await assert.rejects(runBoundedTasks([async () => 1], 0), /concurrency.*positive integer/i);
  });
});
