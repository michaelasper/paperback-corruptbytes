import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  LETTERS,
  groupsListUrl,
  parseGroupsList,
  summarizeContactDomains,
} from "./mangaupdates-groups.mjs";

const USER_AGENT =
  "paperback-corruptbytes-internal-tool (+https://github.com/michaelasper/paperback-corruptbytes)";
const DELAY_MS = 800;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const fetchText = async (url) => {
  const response = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!response.ok) throw new Error(`MangaUpdates returned ${response.status} for ${url}.`);
  return response.text();
};

const onlyLetters = (process.argv.slice(2).find((arg) => arg.startsWith("--letters=")) ?? "")
  .replace("--letters=", "")
  .split(",")
  .map((letter) => letter.trim().toUpperCase())
  .filter(Boolean);

const outDir =
  process.argv
    .slice(2)
    .find((arg) => arg.startsWith("--out="))
    ?.replace("--out=", "") ?? "out/scanlators";

const letters = onlyLetters.length > 0 ? onlyLetters : LETTERS.filter((letter) => letter !== "ALL");

const groups = [];
for (const letter of letters) {
  const url = groupsListUrl(letter);
  process.stdout.write(`Fetching ${url}\n`);
  const html = await fetchText(url);
  const parsed = parseGroupsList(html, letter);
  process.stdout.write(`Parsed ${parsed.length} groups for ${letter}\n`);
  groups.push(...parsed);
  await sleep(DELAY_MS);
}

await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, "groups.json"), JSON.stringify(groups, null, 2));
await writeFile(
  join(outDir, "domains.json"),
  JSON.stringify(summarizeContactDomains(groups), null, 2),
);
process.stdout.write(`Wrote ${groups.length} groups to ${outDir}/groups.json\n`);
