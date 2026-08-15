import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("CI gates every reachable live protocol and isolates only MadaraDex's runner block", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  const githubLive = packageJson.scripts?.["test:live:github"];
  assert.equal(typeof githubLive, "string");
  for (const environmentName of [
    "ATSUMARU_LIVE_TESTS",
    "DIVA_LIVE_TESTS",
    "MGEKO_LIVE_TESTS",
    "THUNDER_LIVE_TESTS",
    "VALIR_LIVE_TESTS",
    "VORTEX_LIVE_TESTS",
  ]) {
    assert.match(githubLive, new RegExp(`${environmentName}=1`));
  }
  assert.doesNotMatch(githubLive, /MADARADEX_LIVE_TESTS/);
  assert.match(githubLive, /tsx --test src\/\*\/live\.test\.ts/);

  const workflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.match(
    workflow,
    /name: Run GitHub-reachable public contract tests\n\s+run: npm run test:live:github/,
  );
  assert.match(
    workflow,
    /name: Probe MadaraDex from GitHub-hosted runner\n\s+id: madaradex-live\n\s+continue-on-error: true\n\s+run: npm run test:live:madaradex/,
  );
  assert.match(workflow, /steps\.madaradex-live\.outcome == 'failure'/);
});
