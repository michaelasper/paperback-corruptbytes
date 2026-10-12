# Discover and search titles

Readers browse home sections, search by title, filter genres, select sorting, and resolve pasted series URLs. Verify the route the user actually used.

## Sub-features

- `discover.rails` loads enabled home sections and subsequent pages.
- `search.title` returns a known title without substituting another series.
- `search.genre` uses the selected genre archive/filter.
- `search.sort` honors a supported sort on its supported route.
- `search.pasted` resolves the source's canonical URL and retains its ID.

## How to get to it (user POV)

Open a source's discovery page and select a rail or genre. Open search, enter a title, and select a sorting option. Paste a series URL into search where the source supports it. Do not treat the title-search route as proof of the genre or pasted-URL route.

## Driving it with live source contracts

Preconditions: Launch and Doctor passed. No source account is required for the anonymous contracts. Capture each command and exit code with its log.

- Rokari title/genre/sort. Run `npm run test:live:rokari > "$VERIFY_EVIDENCE/discovery-rokari.log" 2>&1`. Require the taxonomy, `Action` query, `Bunker` result with ID `bunker-days`, and advertised Popular catalog tests to pass. The deterministic dispatch regression is `./node_modules/.bin/tsx --test src/Rokari/main.test.ts`; it proves Popular requests `order=popular` while keyword and genre precedence remain unchanged.
- Atsumaru rails/search/ratings. Run `npm run test:live:atsumaru > "$VERIFY_EVIDENCE/discovery-atsumaru.log" 2>&1`. Require all enabled home rails, `Pick Me Up` with ID `oJQ4o`, and the five literal detail-rating expectations. Follow the current named tests in `src/Atsumaru/live.test.ts`, not a frozen item count.
- Rinko pasted URL and genre. Run `npm run test:live:rinko > "$VERIFY_EVIDENCE/discovery-rinko.log" 2>&1`. Require the REST search, HTML genre filtering, and canonical pasted-target tests. They are separate entry points.
- Other sources. Run `npm run test:live` for the complete gate set. Read each source's test names and assertions before claiming pagination or sort coverage. Some live cases call parsers directly rather than the entire client.
- Native proof. With an available device driver, repeat the affected entry point in Paperback and capture the selected source, query/filter/sort, resulting cards, and opened series. If unavailable, mark native discovery NOT RUN.

## Gotchas

- Blank catalog sorting is not automatically supported by keyword or genre routes. Rokari intentionally applies Popular only to blank, unfiltered search.
- A nonempty result alone does not prove query relevance or the selected order. Use the literal target-ID and dispatch assertions.
- Content-profile filtering can hide a source before discovery. That belongs to installation visibility, not an empty-catalog parser fix.
- `npm run test:live:random` currently excludes Rokari and Temple. Its random seed supports replay, not all-source coverage.
- Refresh fixtures when titles or catalog totals legitimately change. Never loosen a test solely to turn an unexplained failure green.
