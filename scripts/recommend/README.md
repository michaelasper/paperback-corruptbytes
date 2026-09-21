# Backup recommendation engine

Local only script pair. No backup data is committed.

## Score the backup

```sh
node scripts/recommend/score-backup.mjs --backup=/path/to/Paperback-Archive.pas5 > /tmp/rec-report.json
```

Reads the library, tracked series, series info, chapters, and progress
markers. Scores each series as completed times a completion ratio bonus.
Writes the top series plus a tag profile to stdout.

## Match against MangaUpdates

```sh
node scripts/recommend/match-mu.mjs
```

Reads `/tmp/rec-report.json`. Searches MangaUpdates for the top liked
titles. Collects genres, related series, and scanlator groups. Votes are
weighted by the backup score. Writes `/tmp/rec/mu-match.json`.

Requests run with a polite delay and a tool user agent.
