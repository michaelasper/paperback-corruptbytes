import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const BACKUP = process.argv.find((arg) => arg.startsWith("--backup="))?.replace("--backup=", "") ??
  "/Users/asper/Downloads/Paperback-Archive.20-09-2026.16-37-26.pas5";

const readStore = async (dir, name) => {
  const { stdout } = await execFileAsync("unzip", ["-p", BACKUP, name], { maxBuffer: 32 * 1024 * 1024 });
  return JSON.parse(stdout);
};

const { stdout: names } = await execFileAsync("unzip", ["-l", BACKUP], { maxBuffer: 1024 * 1024 });
const files = names.split("\n").map((line) => line.trim().split(/\s+/).pop()).filter(Boolean);

const loadAll = async (prefix) => {
  let merged = {};
  for (const name of files.filter((file) => file.startsWith(prefix))) {
    merged = { ...merged, ...(await readStore(null, name)) };
  }
  return merged;
};

const lib = await loadAll("__LIBRARY_MANGA_V5");
const src = await loadAll("__SOURCE_MANGA_V5");
const info = await loadAll("__MANGA_INFO_V5");
const chaps = await loadAll("__CHAPTER_V5");
const marks = await loadAll("__CHAPTER_PROGRESS_MARKER_V5");

const avail = new Map();
for (const chapter of Object.values(chaps)) {
  const sid = chapter?.sourceManga?.id;
  if (typeof sid !== "string") continue;
  if (!avail.has(sid)) avail.set(sid, []);
  avail.get(sid).push(chapter.id);
}

const ch2sid = new Map();
for (const [sid, ids] of avail) for (const id of ids) ch2sid.set(id, sid);

const completedBySeries = new Map();
let completedTotal = 0;
for (const marker of Object.values(marks)) {
  if (marker?.completed !== true) continue;
  const cid = marker?.chapter?.id;
  const sid = typeof cid === "string" ? ch2sid.get(cid) : undefined;
  if (!sid) continue;
  completedBySeries.set(sid, (completedBySeries.get(sid) ?? 0) + 1);
  completedTotal += 1;
}

const titlesOf = (entry) => {
  const primary = entry?.primaryTitle ?? "";
  const secondary = entry?.secondaryTitles ?? [];
  return [primary, ...secondary].filter((title) => typeof title === "string" && title.trim());
};

const scored = [];
for (const [sid, chapters] of avail) {
  const source = src[sid];
  if (!source) continue;
  const meta = info[source?.mangaInfo?.id];
  const available = chapters.length;
  const completed = completedBySeries.get(sid) ?? 0;
  if (available === 0) continue;
  const ratio = completed / available;
  const score = completed * (0.5 + 0.5 * ratio);
  scored.push({
    sourceId: source.sourceId,
    mangaId: source.mangaId,
    titles: titlesOf(meta),
    tags: (meta?.tagGroups ?? []).flatMap((group) => group.tags.map((tag) => tag.title)),
    available,
    completed,
    ratio: Math.round(ratio * 100) / 100,
    score: Math.round(score * 100) / 100,
  });
}
scored.sort((left, right) => right.score - left.score);

const tagWeights = new Map();
for (const entry of scored.slice(0, 60)) {
  for (const tag of new Set(entry.tags)) {
    tagWeights.set(tag, (tagWeights.get(tag) ?? 0) + entry.score);
  }
}

const report = {
  libraryTitles: Object.keys(lib).length,
  trackedSeries: scored.length,
  chaptersAvailable: chaps ? Object.keys(chaps).length : 0,
  chaptersCompleted: completedTotal,
  topSeries: scored.slice(0, 30),
  tagProfile: [...tagWeights.entries()]
    .map(([tag, weight]) => ({ tag, weight: Math.round(weight * 100) / 100 }))
    .sort((left, right) => right.weight - left.weight)
    .slice(0, 25),
};

process.stdout.write(JSON.stringify(report, null, 2));
