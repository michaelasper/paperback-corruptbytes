import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const BACKUPS = process.argv
  .filter((arg) => arg.startsWith("--backup="))
  .map((arg) => arg.slice("--backup=".length))
  .filter(Boolean);
if (BACKUPS.length === 0) {
  BACKUPS.push("/Users/asper/Downloads/Paperback-Archive.20-09-2026.16-37-26.pas5");
}

const readStore = async (archive, name) => {
  const { stdout } = await execFileAsync("unzip", ["-p", archive, name], {
    maxBuffer: 32 * 1024 * 1024,
  });
  return JSON.parse(stdout);
};

const archiveFiles = async (archive) => {
  const { stdout: names } = await execFileAsync("unzip", ["-l", archive], {
    maxBuffer: 1024 * 1024,
  });
  return names.split("\n").map((line) => line.trim().split(/\s+/).pop()).filter(Boolean);
};

const isNewerMarker = (next, prev) =>
  (next?.completed === true && prev?.completed !== true) ||
  (next?.time ?? 0) > (prev?.time ?? 0);

const loadAll = async (prefix) => {
  let merged = {};
  for (const archive of BACKUPS) {
    const files = await archiveFiles(archive);
    for (const name of files.filter((file) => file.startsWith(prefix))) {
      const store = await readStore(archive, name);
      for (const [id, record] of Object.entries(store)) {
        if (prefix === "__CHAPTER_PROGRESS_MARKER_V5" && merged[id] && !isNewerMarker(record, merged[id])) {
          continue;
        }
        if (prefix === "__LIBRARY_MANGA_V5" && merged[id] && (merged[id]?.lastRead ?? 0) >= (record?.lastRead ?? 0)) {
          continue;
        }
        merged[id] = record;
      }
    }
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

const HALF_LIFE_DAYS = Number(process.env.REC_HALF_LIFE_DAYS ?? 120);
const ADULT_SOURCES = new Set(
  (process.env.REC_ADULT_SOURCES ?? "divascans,templetoons,valirscans")
    .split(",")
    .map((source) => source.trim().toLowerCase())
    .filter(Boolean),
);
const ADULT_SOURCE_BOOST = Number(process.env.REC_ADULT_BOOST ?? 1.25);

const completedBySeries = new Map();
const lastActivityBySeries = new Map();
let completedTotal = 0;
let newestStamp = 0;
for (const marker of Object.values(marks)) {
  if (typeof marker?.time === "number" && marker.time > newestStamp) newestStamp = marker.time;
  if (marker?.completed !== true) continue;
  const cid = marker?.chapter?.id;
  const sid = typeof cid === "string" ? ch2sid.get(cid) : undefined;
  if (!sid) continue;
  completedBySeries.set(sid, (completedBySeries.get(sid) ?? 0) + 1);
  completedTotal += 1;
  if (typeof marker.time === "number") {
    lastActivityBySeries.set(sid, Math.max(lastActivityBySeries.get(sid) ?? 0, marker.time));
  }
}
for (const entry of Object.values(lib)) {
  const stamp = entry?.lastRead;
  if (typeof stamp !== "number" || stamp <= 0) continue;
  if (stamp > newestStamp) newestStamp = stamp;
  for (const attached of entry?.attachedSources ?? []) {
    if (attached?.type !== "__SOURCE_MANGA_V5" || typeof attached.id !== "string") continue;
    lastActivityBySeries.set(
      attached.id,
      Math.max(lastActivityBySeries.get(attached.id) ?? 0, stamp),
    );
  }
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
  const fromAdultSource = ADULT_SOURCES.has(String(source.sourceId ?? "").toLowerCase());
  const ratio = completed / available;
  const lastActivity = lastActivityBySeries.get(sid) ?? 0;
  const daysAgo = lastActivity > 0 ? Math.max(0, (newestStamp - lastActivity) / 86400) : 365;
  const recency = 0.5 + 0.5 * Math.exp(-daysAgo / HALF_LIFE_DAYS);
  const score = completed * (0.5 + 0.5 * ratio) * recency * (fromAdultSource ? ADULT_SOURCE_BOOST : 1);
  const tags = (meta?.tagGroups ?? []).flatMap((group) => group.tags.map((tag) => tag.title));
  if (fromAdultSource && !tags.some((tag) => tag.toLowerCase() === "adult")) tags.push("Adult (source)");
  scored.push({
    sourceId: source.sourceId,
    mangaId: source.mangaId,
    titles: titlesOf(meta),
    tags,
    available,
    completed,
    ratio: Math.round(ratio * 100) / 100,
    daysAgo: Math.round(daysAgo),
    recency: Math.round(recency * 100) / 100,
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
