<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/logo-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset=".github/logo-light.svg">
    <img alt="corruptbytes" src=".github/logo-light.svg" width="440">
  </picture>
  <p>High-care Paperback sources for readers who want reliable catalogs, search, and legitimately accessible chapters.</p>
</div>

<div align="center">

[![Paperback 0.9.x][paperback-shield]][paperback-url]
[![CI and Pages][ci-shield]][ci-url]
[![Node.js 24+][node-shield]][node-url]
[![License: All rights reserved][license-shield]][license-url]

</div>

<div align="center">
  <a href="#quick-start">Quick Start</a> &middot;
  <a href="#available-extensions">Extensions</a> &middot;
  <a href="#development">Development</a> &middot;
  <a href="https://github.com/michaelasper/paperback-corruptbytes/issues/new?labels=bug">Report Bug</a>
</div>

---

## Why this repository?

If you use Paperback daily and care more about correctness than the number of sources installed, this repository is for you. Each extension receives site-specific parsing, stable identifiers, account-aware access handling, deterministic regression tests, and live protocol checks instead of inheriting a fragile generic scraper.

It is not a paywall bypass. Extensions never purchase, unlock, or fabricate access to chapters that the source does not make available to your account.

## Highlights

- **Read the formats each site actually publishes.** Comic image readers and novel HTML readers preserve source order and reject unsafe content.
- **Keep existing library progress.** Each adapter preserves the IDs already present in Paperback exports, including Atsumaru’s opaque scanlation IDs, Mgeko slugs, MadaraDex post IDs, and fractional chapter IDs.
- **Use chapters you legitimately purchased.** First-party sessions expose only content the signed-in site reports as accessible; unavailable chapters remain visibly locked.
- **Browse complete catalogs.** Discovery feeds, pagination, genres, sorting, advanced filters, title search, and pasted series URLs follow each site’s real protocol.
- **Use the right authentication model for each site.** Account sign-in stays on the source’s own page; MadaraDex reader authorization refreshes automatically; Mgeko needs no account.
- **Fail clearly under site changes.** Cloudflare challenges, rate limits, malformed responses, and locked pages produce targeted errors instead of empty readers or invalid URLs.
- **Ship changes with evidence.** Shared engine components and source adapters are covered by deterministic tests plus scheduled live public-contract checks.

## Available extensions

| Extension                                                                        | Status | Best for                                                                                                                |
| -------------------------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------- |
| <img src="src/Atsumaru/static/icon.png" alt="" width="28"> **Atsumaru**          | Alpha  | Comics, novels, all anonymous discovery rails, 2,408-tag search, and exported-library chapter compatibility             |
| <img src="src/MadaraDex/static/icon.png" alt="" width="28"> **MadaraDex**        | Alpha  | Complete Madara discovery/search, exported numeric-ID compatibility, and automatically authorized image readers         |
| <img src="src/Mgeko/static/icon.png" alt="" width="28"> **Mgeko**                | Alpha  | A large safe-mode catalog, detailed range/rating/availability filters, and stable comic reader slugs                    |
| <img src="src/Thunderscans/static/icon.png" alt="" width="28"> **Thunder Scans** | Alpha  | Comics, novels, complete discovery/search, coin-lock visibility, and chapters already available to your Thunder account |
| <img src="src/VortexScans/static/icon.png" alt="" width="28"> **Vortex Scans**   | Alpha  | Comics, novels, rich filters, paid-state metadata, and chapters already purchased through Vortex                        |

### Atsumaru

- All 13 anonymous manga discovery rails, live genres, exact Typesense sorting, pasted series URLs, and comic or novel search.
- Include/exclude filters for 21 genres and 2,408 detailed tags, organized into 17 on-demand groups so the initial form stays fast.
- Exact case-sensitive manga, chapter, and scanlation IDs—including alternate translations—preserve the exported library’s reading progress.
- Direct CDN comic pages, escaped XHTML novel chapters, standard-by-default catalog controls with explicit rating filters, and no account requirement.

### MadaraDex

- New series, recent chapter updates, trending titles, most viewed, top rated, genres, and all seven live sort modes.
- Complete genre, matching mode, author, artist, release year, adult-content, and status filters.
- Numeric WordPress post IDs and exact chapter IDs remain compatible with existing Paperback libraries and reading progress.
- Anonymous reader authorization, authenticated CDN delivery, retry-once recovery, inline and AJAX chapter lists, and encrypted chapter-protector support.

### Mgeko

- Popular all time, top rated, latest updates, recently added, popular today, genres, and all nine live sort modes.
- Include/exclude genres, status, format, tags, chapter range, minimum rating, completion, translation, and break-status filters.
- Safe mode is enabled by default and is sent to Mgeko’s catalog API for every discovery and title-search request.
- Exact archived series and reader slugs, fractional chapter numbers, deterministic dates, and clean image-page ordering.

### Thunder Scans

- Popular today, editor’s picks, latest comics, latest novels, recently added titles, and the full genre catalog.
- Status, format, genre, and directory sorting filters, with accurate filtered title search through Thunder’s structured endpoint.
- Stable chapter IDs, exact chapter URL reuse, lock and coin-price labels, and a preference to hide unavailable chapters.
- First-party profile validation and purchased-chapter access without any automated purchase or unlock action.

### Vortex Scans

- Latest updates, popular titles, recently added series, genres, pagination, and sorting.
- Title and pasted-URL search with status, type, direction, and include/exclude genre filters.
- Google or Discord sign-in, paid-state metadata, and access to chapters Vortex reports as purchased.
- Comic images and sanitized novel HTML with deterministic page order.

## Quick start

1. Open the [repository installation page][install-page] on the device running Paperback.
2. Add **paperback-corruptbytes** as a repository.
3. Install any combination of Atsumaru, MadaraDex, Mgeko, Thunder Scans, and Vortex Scans.

## Account-backed chapters

Thunder Scans and Vortex Scans can expose chapters the signed-in site reports as purchased. Open the extension’s settings, choose its sign-in action, complete authentication on the source’s first-party page, return to the account or profile page, then tap **Done** so Paperback can import only the resulting source cookies.

Paperback’s embedded browser does not currently provide a secure external-browser or passkey handoff. If your normal sign-in depends on a passkey, use another first-party method the source offers inside the embedded view.

MadaraDex does not require a user account. Its short-lived anonymous reader token refreshes automatically; the settings screen also offers a manual refresh and first-party verification view. Atsumaru and Mgeko do not require authentication.

## Install from source

```bash
git clone https://github.com/michaelasper/paperback-corruptbytes.git
cd paperback-corruptbytes
npm ci
npm run serve
```

Open the LAN URL printed by the development server on your Paperback device. Builds from `main` deploy to GitHub Pages automatically.

## Prerequisites

| Requirement    | Version or purpose                                                           |
| -------------- | ---------------------------------------------------------------------------- |
| Paperback      | 0.9.x                                                                        |
| Node.js        | 24 or newer for local development                                            |
| Source account | Optional; used only by account-backed extensions for content you already own |

## Privacy and access boundaries

Every cookie jar accepts only explicitly trusted source domains. Account sessions never travel to unrelated image hosts, stale responses cannot resurrect a cleared session, and logout preserves only non-account Cloudflare clearance. MadaraDex’s anonymous fingerprint and reader token are shared only with its first-party CDN because the CDN requires both the token and source referer. Response bodies are bounded before decoding, and novel content is reduced to safe XHTML before it reaches Paperback’s reader.

No extension in this repository collects credentials, initiates purchases, defeats time or coin locks, or claims access that the source has not granted.

## Development

```bash
npm ci
npm test
npm run conformance
npm run bundle
npm run test:live
npm run test:live:random
```

`npm test` covers deterministic fixtures, authentication boundaries, and the shared engine. `npm run test:live` checks all five public protocols, including Atsumaru’s full anonymous rails and exported-library IDs, discovery, filters, anonymous CDN authorization, readable comics and novels, and real locked states; it never attempts a purchase.

`npm run test:live:random` samples current catalog pages, series, chapter lists, and readable chapters through production parsers. It prints the random seed for replay; set `LIVE_RANDOM_SEED` to that unsigned 32-bit value and `LIVE_RANDOM_SAMPLES` from 1 through 8 to reproduce or widen a run.

Add each extension under `src/<ExtensionName>/` with its own config, implementation, tests, and static assets. Cross-source URL, HTML, cache, request, and cookie behavior belongs in `src/shared/` with regression coverage for every existing consumer.

## Contributing

Focused issues and pull requests are welcome. Include a regression test for behavior changes and run `npm test`, `npm run conformance`, and `npm run bundle` before opening a pull request.

## License

Copyright is reserved. No permission to copy, modify, or redistribute the software is granted without prior written permission; see [LICENSE](LICENSE).

## Acknowledgments

- [nyzzik/extensions](https://github.com/nyzzik/extensions) for the Asura Scans extension used as an early structural reference.
- [Inkdex general extensions](https://github.com/inkdex/general-extensions) for current Paperback 0.9.x project conventions.
- [Keiyoushi extensions-source](https://github.com/keiyoushi/extensions-source) for independent Vortex, Mgeko, and MadaraDex protocol references.
- [Inkdex Madara extensions](https://github.com/inkdex/madara-extensions) and [Nicartjay PaperbackExt](https://github.com/Nicartjay/PaperbackExt) for additional Madara protocol cross-checks.

---

Crafted with [Readme Craft](https://github.com/motiful/readme-craft)

[ci-shield]: https://github.com/michaelasper/paperback-corruptbytes/actions/workflows/ci.yml/badge.svg
[ci-url]: https://github.com/michaelasper/paperback-corruptbytes/actions/workflows/ci.yml
[install-page]: https://michaelasper.github.io/paperback-corruptbytes/
[license-shield]: https://img.shields.io/badge/license-all%20rights%20reserved-5c6370
[license-url]: LICENSE
[node-shield]: https://img.shields.io/badge/Node.js-24%2B-339933
[node-url]: https://nodejs.org/
[paperback-shield]: https://img.shields.io/badge/Paperback-0.9.x-6f42c1
[paperback-url]: https://github.com/Paperback-iOS/app
