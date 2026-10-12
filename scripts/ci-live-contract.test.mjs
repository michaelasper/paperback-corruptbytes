import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

void test("CI gates reachable protocols and explicitly reports access-blocked probes", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  const githubLive = packageJson.scripts?.["test:live:github"];
  assert.equal(typeof githubLive, "string");
  for (const environmentName of [
    "ATSUMARU_LIVE_TESTS",
    "DIVA_LIVE_TESTS",
    "MGEKO_LIVE_TESTS",
    "QIMANGA_LIVE_TESTS",
    "RINKO_LIVE_TESTS",
    "ROKARI_LIVE_TESTS",
    "THUNDER_LIVE_TESTS",
    "VALIR_LIVE_TESTS",
    "VORTEX_LIVE_TESTS",
  ]) {
    assert.match(githubLive, new RegExp(`${environmentName}=1`));
  }
  assert.doesNotMatch(githubLive, /MADARADEX_LIVE_TESTS|TEMPLE_LIVE_TESTS/);
  const allLive = packageJson.scripts?.["test:live"];
  assert.equal(typeof allLive, "string");
  for (const environmentName of [
    "ATSUMARU",
    "DIVA",
    "MADARADEX",
    "MGEKO",
    "QIMANGA",
    "RINKO",
    "ROKARI",
    "TEMPLE",
    "THUNDER",
    "VALIR",
    "VORTEX",
  ]) {
    assert.match(allLive, new RegExp(`${environmentName}_LIVE_TESTS=1`));
  }
  assert.match(githubLive, /tsx --test src\/\*\/live\.test\.ts/);
  assert.match(allLive, /tsx --test src\/\*\/live\.test\.ts/);

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
  assert.match(
    workflow,
    /name: Probe Temple Scan from GitHub-hosted runner\n\s+id: temple-live\n\s+continue-on-error: true\n\s+run: npm run test:live:temple/,
  );
  assert.match(workflow, /steps\.temple-live\.outcome == 'failure'/);
});
