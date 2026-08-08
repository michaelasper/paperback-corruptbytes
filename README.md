<div align="center">
  <h1>Paperback CorruptBytes</h1>
  <p>Paperback 0.9 extensions maintained by CorruptBytes.</p>
</div>

<div align="center">

[![Paperback 0.9.x][paperback-shield]][paperback-url]
[![CI and Pages][ci-shield]][ci-url]

</div>

<div align="center">
  <a href="#quick-start">Quick Start</a> &middot;
  <a href="#available-extensions">Extensions</a> &middot;
  <a href="#development">Development</a> &middot;
  <a href="https://github.com/michaelasper/paperback-corruptbytes/issues/new?labels=bug">Report Bug</a>
</div>

---

## Why Paperback CorruptBytes?

This repository is a home for independent Paperback sources that need careful protocol handling, strong regression coverage, and ongoing maintenance. It is intentionally site-neutral: each source lives in its own directory and ships through one installable repository.

## Available Extensions

| Extension                                                                      | Status | Highlights                                                                                                     |
| ------------------------------------------------------------------------------ | ------ | -------------------------------------------------------------------------------------------------------------- |
| <img src="src/VortexScans/static/icon.png" alt="" width="28"> **Vortex Scans** | Alpha  | Discover, advanced search, comics, novels, lock and price state, and access to legitimately purchased chapters |

### Vortex Scans

Vortex serves free and paid chapters through different access paths. The extension understands both while respecting the access state returned for the signed-in account.

- Opens Vortex’s Google or Discord sign-in page without handling your password.
- Reads chapters Vortex reports as accessible, including chapters already purchased by the account.
- Shows paid chapter prices and lock state, with a setting to include or hide unavailable chapters.
- Supports comic images and sanitized novel HTML with deterministic page order.
- Provides latest updates, popular titles, recently added series, genres, pagination, and sorting.
- Searches by title or pasted Vortex URL, with status, type, direction, and include/exclude genre filters.
- Keeps first-party session cookies in source-scoped secure state and clears rejected sessions.
- Handles Vortex rate limits and Cloudflare challenges without confusing ordinary locked responses for challenges.

## Quick Start

1. Open the [repository installation page][install-page] on the device running Paperback.
2. Add **Paperback CorruptBytes** as a repository.
3. Install any extension listed above.

For Vortex purchased chapters, open the extension settings, choose **Sign in to Vortex Scans**, and complete Google or Discord sign-in. Chapters become readable only after Vortex validates the session; unavailable paid chapters remain visibly locked.

After Vortex returns to its home page, tap **Done** to import the session into the extension. Paperback’s embedded browser does not currently provide a secure external-browser or passkey handoff, so that authentication must finish inside the sign-in view.

## Install From Source

```bash
git clone https://github.com/michaelasper/paperback-corruptbytes.git
cd paperback-corruptbytes
npm ci
npm run serve
```

Open the LAN URL printed by the development server on your Paperback device. The hosted repository is built from `main` and deployed to GitHub Pages automatically.

## Prerequisites

| Requirement    | Version or purpose                                 |
| -------------- | -------------------------------------------------- |
| Paperback      | 0.9.x                                              |
| Node.js        | 24 or newer for local development                  |
| Source account | Optional; required only for account-gated features |

## Privacy and Access Boundaries

Extensions in this repository must not bypass payments, collect credentials, or expose session material to unrelated hosts. Vortex authentication stays on Vortex’s own sign-in page; its extension stores only first-party `vortexscans.org` cookies in Paperback secure state and reads only content Vortex reports as accessible.

## Development

```bash
npm ci
npm test
npm run test:live
npm run conformance
npm run bundle
```

The default suite runs every extension’s deterministic tests. `npm run test:live` currently checks Vortex’s OAuth providers, anonymous account contract, catalog filters, one readable chapter, and one real locked chapter; it never attempts a purchase.

Each extension belongs in `src/<ExtensionName>/` with its own config, implementation, static assets, and focused tests. Shared repository commands discover all first-level extension directories, so future sources can be added without rebranding the project.

## Contributing

Issues and focused pull requests are welcome. Please include a regression test for behavior changes and run `npm test`, `npm run conformance`, and `npm run bundle` before opening a pull request.

## License

No software license is currently granted. The repository is publicly available for inspection and installation, but copyright remains with its contributors unless a license is added later.

## Acknowledgments

- [nyzzik/extensions](https://github.com/nyzzik/extensions) for the Asura Scans extension used as an early structural reference.
- [Inkdex general extensions](https://github.com/inkdex/general-extensions) for current Paperback 0.9.x project conventions.
- [Keiyoushi extensions-source](https://github.com/keiyoushi/extensions-source) for a second independent Vortex protocol reference.

---

Crafted with [Readme Craft](https://github.com/motiful/readme-craft)

[ci-shield]: https://github.com/michaelasper/paperback-corruptbytes/actions/workflows/ci.yml/badge.svg
[ci-url]: https://github.com/michaelasper/paperback-corruptbytes/actions/workflows/ci.yml
[install-page]: https://michaelasper.github.io/paperback-corruptbytes/
[paperback-shield]: https://img.shields.io/badge/Paperback-0.9.x-6f42c1
[paperback-url]: https://github.com/Paperback-iOS/app
