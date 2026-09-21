import { readFile, writeFile, mkdir } from "node:fs/promises";

const UA = "paperback-corruptbytes-recommend/1.0 (+https://github.com/michaelasper/paperback-corruptbytes)";
const DELAY_MS = 1200;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const report = JSON.parse(await readFile("/tmp/rec-report.json", "utf8"));
const owned = new Set(
  report.topSeries.flatMap((entry) => entry.titles).map((title) => title.toLowerCase()),
);

const fetchText = async (url) => {
  const response = await fetch(url, { headers: { "User-Agent": UA } });
  if (!response.ok) throw new Error(`${response.status} for ${url}`);
  return response.text();
};

const firstSeriesHit = (html) => {
  const match = html.match(/https:\/\/www\.mangaupdates\.com\/series\/[a-z0-9]+\/[^"<>?#\\]+/);
  return match?.[0];
};

const genresOf = (html) => {
  const combined = [...html.matchAll(/\/series\?genre=([A-Za-z_\-]+)"/g)]
    .map((match) => match[1].split("_"))
    .sort((left, right) => right.length - left.length)[0] ?? [];
  return [...new Set(combined)];
};

const relatedOf = (html) => {
  const links = [...html.matchAll(/href="(https:\/\/www\.mangaupdates\.com\/series\/[a-z0-9]+\/[^"<>?#\\]+)"/g)]
    .map((match) => match[1]);
  return [...new Set(links)];
};

const groupsOf = (html) => {
  const links = [...html.matchAll(/href="(https:\/\/www\.mangaupdates\.com\/group\/[a-z0-9]+\/[^"<>?#\\]+)"/g)]
    .map((match) => match[1]);
  return [...new Set(links)];
};

const matched = [];
const relatedVotes = new Map();
const groupVotes = new Map();

for (const entry of report.topSeries.slice(0, 15)) {
  const title = entry.titles[0] ?? entry.mangaId;
  try {
    const searchHtml = await fetchText(
      `https://www.mangaupdates.com/site/search/result?search=${encodeURIComponent(title)}`,
    );
    const seriesUrl = firstSeriesHit(searchHtml);
    await sleep(DELAY_MS);
    if (!seriesUrl) {
      matched.push({ title, score: entry.score, seriesUrl: null });
      continue;
    }
    const seriesHtml = await fetchText(seriesUrl);
    await sleep(DELAY_MS);
    const genres = genresOf(seriesHtml);
    const related = relatedOf(seriesHtml).filter((url) => url !== seriesUrl).slice(0, 12);
    const groups = groupsOf(seriesHtml);
    for (const url of related) {
      const vote = relatedVotes.get(url) ?? { votes: 0, from: [] };
      vote.votes += entry.score;
      vote.from.push(title);
      relatedVotes.set(url, vote);
    }
    for (const url of groups) {
      const vote = groupVotes.get(url) ?? { votes: 0, from: [] };
      vote.votes += entry.score;
      vote.from.push(title);
      groupVotes.set(url, vote);
    }
    matched.push({ title, score: entry.score, seriesUrl, genres });
    process.stdout.write(`Matched ${title} -> ${seriesUrl} [${genres.join(", ")}]\n`);
  } catch (error) {
    matched.push({ title, score: entry.score, error: String(error) });
    process.stdout.write(`Miss ${title}: ${String(error)}\n`);
  }
}

const titlesInLibrary = new Set(
  report.topSeries.flatMap((entry) => entry.titles.map((title) => title.toLowerCase())),
);

const out = {
  matched,
  related: [...relatedVotes.entries()]
    .map(([url, vote]) => ({ url, votes: Math.round(vote.votes), from: vote.from.slice(0, 3) }))
    .sort((left, right) => right.votes - left.votes)
    .slice(0, 30),
  groups: [...groupVotes.entries()]
    .map(([url, vote]) => ({ url, votes: Math.round(vote.votes), from: vote.from.slice(0, 3) }))
    .sort((left, right) => right.votes - left.votes)
    .slice(0, 15),
  ownedTitles: titlesInLibrary.size,
};

await mkdir("/tmp/rec", { recursive: true });
await writeFile("/tmp/rec/mu-match.json", JSON.stringify(out, null, 2));
process.stdout.write(`Wrote ${matched.length} matches, ${out.related.length} related, ${out.groups.length} groups\n`);
