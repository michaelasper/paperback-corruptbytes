# Backup recommendation engine

Local only script pair. No backup data is committed.

## Score the backup

```sh
node scripts/recommend/score-backup.mjs --backup=/path/to/Paperback-Archive.pas5 > /tmp/rec-report.json
```

Reads the library, tracked series, series info, chapters, and progress
markers. Scores each series as completed times a completion ratio bonus
times a recency factor. Recency uses the latest read or marker stamp per
series with exponential decay. Half life defaults to 120 days and can be
set with REC_HALF_LIFE_DAYS. Each entry reports daysAgo and recency.
Writes the top series plus a tag profile to stdout.

## Match against MangaUpdates

```sh
node scripts/recommend/match-mu.mjs
```

Reads `/tmp/rec-report.json`. Searches MangaUpdates for the top liked
titles. Collects genres, related series, and scanlator groups. Votes are
weighted by the backup score. Writes `/tmp/rec/mu-match.json`.

## Genre filters

```sh
node scripts/recommend/match-mu.mjs --include-genres=action,fantasy --exclude-genres=hentai,adult
```

Each top related candidate gets its series page fetched for genres.
Candidates outside the include list or inside the exclude list are
dropped. `--max-enrich=30` bounds the extra fetches.

Requests run with a polite delay and a tool user agent.
