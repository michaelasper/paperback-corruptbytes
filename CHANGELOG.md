# Changelog

## Penguin Squad 1.0.1

### Fixed

- Advance to the next chapter in reading order instead of the previous chapter. Assign sorting indices over the full chronological history before date filtering so incremental refreshes retain the same indices.
- Preserve chapter IDs, manga association, access labels, dates, and reader behavior. Refresh the chapter list after updating. Native Paperback navigation and persisted progress have not been verified.

## 1.2.0

### Added

- Penguin Squad (`src/PenguinSquad`, 1.0.0) for translated novels: one `All novels` catalog rail over real `/novels?page=N` server pages, `/search?q=` keyword search, pasted series and chapter URLs, complete chapter histories, and sanitized public novel readers.
- Chapter identity and access come from the series page's structured chapter records, corroborated by that page's chapter links and declared totals. Premium, unverified, missing, malformed, and conflicting records never default to public.
- Public reads re-read the series records before fetching a chapter, then independently refuse a page that still carries a sign-in or unlock gate, a clipped preview wrapper, or a mismatched canonical, JSON-LD, or series identity.
- Covers and in-reader images are limited to the observed media host; the shared HTML sanitizer removes unsafe markup while retaining chapter prose and the site's translation attribution.

### Changed

- Every pre-existing source advances a patch version, Atsumaru to `1.1.1` and the other nine to `1.0.2`, because this release changes the shipped bundle bytes at the same source version. Nine bundles now embed the `alpha.95` cookie interceptor semantics (persist on set, delete expired cookies, materialise `expires`) and all bundles are rebuilt by rolldown 1.3.3. Penguin Squad ships at `1.0.0` and the repository is `1.2.0`.

### Verification

- Deterministic suites cover 60-card catalog continuation, terminal and empty pages, recommendation-rail exclusion, search echo binding, duplicate and conflicting chapter records, declared count mismatches, forged pagination links, every access-gate variant, and media allowlisting. Synthetic fixtures only; no chapter prose is committed.
- Compiled-export tests rebuild `src/PenguinSquad/main.ts` with rolldown and drive chapter association, catalog pagination, search, and premium refusal through the generated bundle.
- `npm run test:live:penguin` traverses the live catalog to its terminal page, checks the requested series' relational chapter counts and chapter 281 reader HTML, and refuses the currently premium chapter without logging prose. Penguin Squad is registered in `npm run test:live`, in randomized live probes, and in the GitHub-runner live job.
- Dependencies: `@paperback/toolchain` and `@paperback/types` move to `1.0.0-alpha.95` (the `alpha` dist-tag; the `latest` tag still points at the older `alpha.64`), `oxfmt` to 0.79.0, `oxlint` to 1.94.0, `oxlint-tsgolint` to 7.0.2008, and `rolldown` to 1.3.3, with 68 transitive packages refreshed inside their parents' ranges. `npm audit` reports zero vulnerabilities after these compatible updates. Optional and transitive updates remain outside this sweep.
- The `alpha.95` cookie interceptor getter now materialises an absent `expires` as its own key. Five existing cookie suites compare that object shape directly, so their assertions normalise the materialised key; the adapter behaviour and persisted fields are unchanged.
- Native Paperback installation, rendering, and progress persistence were NOT RUN, and no native evidence is claimed.

### Updating

Refresh the saved repository, update Atsumaru to **1.1.1**, Penguin Squad to **1.0.0**, and the other nine extensions to **1.0.2**, then reopen Paperback. Library and chapter IDs are unchanged; no library reset, migration, or backup restore is required.

## 1.1.0

### Fixed

- Preserve the exact app-provided Atsumaru manga association on returned chapters instead of copying it and removing lookup metadata. Keep canonical reader routing separate from the original library ID.
- Retain scanlator labels, alternate translations, backfilled chapters, and stale-ID recovery without changing caller-owned metadata.
- Include the shared NovelDash fixes from main. Read kind-prefixed comic and novel reader responses while retaining support for legacy responses.
- Keep NovelDash text records separate from structured reader data. Reject malformed text records and preserve access-denial checks instead of treating JSON-like prose as a reader response.

### Verification

- Add a regression that fails against the previous association behavior. Exercise restored, frozen, and prototype-backed inputs, unrelated getters, and same-ID cache callers.
- Gate deterministic tests on a freshly compiled Atsumaru export. Gate bundle verification on the actual generated export with fixture-backed transport, real settings, association checks, and recovered reader routing. Keep the existing cold-start checks separate.
- Retain the incoming NovelDash regressions for reader envelopes, text-record boundaries, Unicode byte lengths, and access denial, plus the Diva Scans live novel-reader check.
- Native Paperback installation, chapter persistence, and display after this change are NOT RUN. JavaScript and HTTP checks do not prove native acceptance. The separate Vortex native display discrepancy remains unresolved.

### Updating

Refresh the saved repository and update Atsumaru to **1.1.0** and the other nine installed extensions to **1.0.1**, then refresh the chapter lists. Repository metadata is **1.1.0**. The nine **1.0.1** source versions are inherited from main. Existing library and chapter IDs are unchanged. No library reset, migration, or backup restore is required. Dependencies are unchanged. The repository archive includes both Shiba and Dr Pepper.

## 1.0.0

First stable release of all ten extensions: Atsumaru, Diva Scans, MadaraDex, Mgeko, Qi Manga, Rinko Comics, Rokari, Thunder Scans, Valir Scans, and Vortex Scans. Includes the Shiba theme.

### Fixed

- Prevent an HTML-parser dependency from crashing during extension startup when Paperback provides neither browser `atob` nor Node `Buffer`. Install a binary-safe decoder before loading the parser, without replacing a host-provided decoder.
- Gate release builds on evaluating and initialising every generated source bundle without Node/browser globals.

### Updated

- Upgrade npm dependencies to the newest published direct versions and refresh compatible transitive dependencies. Paperback's SDK/toolchain remain on their newest upstream `alpha` channel; all extension versions are stable **1.0.0**.
- Add seeded Monte Carlo reader coverage for every source: 2,000 generated scenarios, randomized cold starts, and binary-decoder regression samples, alongside existing deeper Qi Manga and Rinko Comics simulations.
- Include Rokari in randomized live catalog, chapter, and reader probes.
- Document Rokari and the alpha-to-stable update path.

### Updating

Refresh the saved repository and update extensions to **1.0.0**, then reopen Paperback. Source and chapter identities are unchanged; keep your existing library. Shiba remains available as `shiba.pbcolors`.

Automated startup, parser, and HTTP checks do not verify native Paperback installation, rendering, or account-cookie handoff. If **UNLOADED** persists after updating, include the extension version, Paperback version, and extension error/log output in a bug report.
