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
- **Keep existing library progress.** Thunder retains the slug-based manga IDs and numeric chapter IDs used by the earlier Paperback source.
- **Use chapters you legitimately purchased.** First-party sessions expose only content the signed-in site reports as accessible; unavailable chapters remain visibly locked.
- **Browse complete catalogs.** Discovery feeds, pagination, genres, sorting, advanced filters, title search, and pasted series URLs follow each site’s real protocol.
- **Sign in without surrendering credentials.** Authentication stays on the source’s own page, and session cookies remain in Paperback’s secure state, source-scoped and blocked from reader CDNs.
- **Fail clearly under site changes.** Cloudflare challenges, rate limits, malformed responses, and locked pages produce targeted errors instead of empty readers or invalid URLs.
- **Ship changes with evidence.** Shared engine components and source adapters are covered by deterministic tests plus scheduled live public-contract checks.

## Available extensions

| Extension                                                                        | Status | Best for                                                                                                                |
| -------------------------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------- |
| <img src="src/Thunderscans/static/icon.png" alt="" width="28"> **Thunder Scans** | Alpha  | Comics, novels, complete discovery/search, coin-lock visibility, and chapters already available to your Thunder account |
| <img src="src/VortexScans/static/icon.png" alt="" width="28"> **Vortex Scans**   | Alpha  | Comics, novels, rich filters, paid-state metadata, and chapters already purchased through Vortex                        |

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
3. Install Thunder Scans, Vortex Scans, or both.

## Sign in for purchased chapters

Open the extension’s settings and choose its sign-in action. Complete authentication on the source’s first-party page, return to the account or profile page, then tap **Done** so Paperback can import only the resulting source cookies.

Paperback’s embedded browser does not currently provide a secure external-browser or passkey handoff. If your normal sign-in depends on a passkey, use another first-party method the source offers inside the embedded view.

## Install from source

```bash
git clone https://github.com/michaelasper/paperback-corruptbytes.git
cd paperback-corruptbytes
npm ci
npm run serve
```

Open the LAN URL printed by the development server on your Paperback device. Builds from `main` deploy to GitHub Pages automatically.

## Prerequisites

| Requirement    | Version or purpose                                                |
| -------------- | ----------------------------------------------------------------- |
| Paperback      | 0.9.x                                                             |
| Node.js        | 24 or newer for local development                                 |
| Source account | Optional; required only for account-gated content you already own |

## Privacy and access boundaries

Every cookie jar accepts only explicitly trusted source domains. Authentication cookies never travel to unrelated image hosts, stale responses cannot resurrect a cleared session, and logout preserves only non-account Cloudflare clearance. Novel content is reduced to a small XHTML allowlist before it reaches Paperback’s reader.

No extension in this repository collects credentials, initiates purchases, defeats time or coin locks, or claims access that the source has not granted.

## Development

```bash
npm ci
npm test
npm run conformance
npm run bundle
npm run test:live
```

`npm test` covers deterministic fixtures, authentication boundaries, and the shared engine. `npm run test:live` checks both public protocols, including discovery, filters, stable IDs, readable comics and novels, and real locked states; it never attempts a purchase.

Add each extension under `src/<ExtensionName>/` with its own config, implementation, tests, and static assets. Cross-source URL, HTML, cache, request, and cookie behavior belongs in `src/shared/` with regression coverage for every existing consumer.

## Contributing

Focused issues and pull requests are welcome. Include a regression test for behavior changes and run `npm test`, `npm run conformance`, and `npm run bundle` before opening a pull request.

## License

Copyright is reserved. No permission to copy, modify, or redistribute the software is granted without prior written permission; see [LICENSE](LICENSE).

## Acknowledgments

- [nyzzik/extensions](https://github.com/nyzzik/extensions) for the Asura Scans extension used as an early structural reference.
- [Inkdex general extensions](https://github.com/inkdex/general-extensions) for current Paperback 0.9.x project conventions.
- [Keiyoushi extensions-source](https://github.com/keiyoushi/extensions-source) for a second independent Vortex protocol reference.

---

Crafted with [Readme Craft](https://github.com/motiful/readme-craft)

[ci-shield]: https://github.com/michaelasper/paperback-corruptbytes/actions/workflows/ci.yml/badge.svg
[ci-url]: https://github.com/michaelasper/paperback-corruptbytes/actions/workflows/ci.yml
[install-page]: https://michaelasper.github.io/paperback-corruptbytes/
[node-shield]: https://img.shields.io/badge/Node.js-24%2B-339933
[node-url]: https://nodejs.org/
[paperback-shield]: https://img.shields.io/badge/Paperback-0.9.x-6f42c1
[paperback-url]: https://github.com/Paperback-iOS/app
