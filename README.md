<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="src/VortexScans/static/icon.png">
    <source media="(prefers-color-scheme: light)" srcset="src/VortexScans/static/icon.png">
    <img alt="Vortex Scans" src="src/VortexScans/static/icon.png" width="104">
  </picture>

  <h1>Paperback CorruptBytes</h1>
  <p>Read Vortex Scans in Paperback—including chapters you legitimately purchased—with first-party sign-in and paid-access awareness.</p>
</div>

<div align="center">

[![Paperback 0.9.x][paperback-shield]][paperback-url]
[![CI and Pages][ci-shield]][ci-url]

</div>

<div align="center">
  <a href="#quick-start">Quick Start</a> &middot;
  <a href="#features">Features</a> &middot;
  <a href="#development">Development</a> &middot;
  <a href="https://github.com/michaelasper/paperback-corruptbytes/issues/new?labels=bug">Report Bug</a>
</div>

---

## Why Paperback CorruptBytes?

Vortex Scans serves free and paid chapters through different access paths, and purchased chapters require a valid Vortex session. This extension is for Paperback 0.9.x readers who want the full catalog, accurate lock state, and access to content already unlocked on their own Vortex account.

## Features

- Opens Vortex’s Google or Discord sign-in page and reads legitimately purchased chapters without handling your password.
- Shows paid chapter prices and lock state, with a setting to include or hide unavailable chapters.
- Supports comic images and sanitized novel HTML while preserving deterministic page order.
- Provides latest updates, popular titles, recently added series, genres, pagination, and sorting.
- Searches by title or pasted Vortex URL, with status, type, direction, and include/exclude genre filters.
- Persists source-scoped session cookies securely, validates the active account, and clears auth state on logout or rejection.
- Handles Vortex rate limits and Cloudflare challenges without misclassifying ordinary locked responses.

## Scope

The extension reads only content Vortex reports as accessible to the signed-in account. It does not purchase chapters, bypass payment, collect credentials, or make unavailable chapters readable.

## Quick Start

1. Open the [repository installation page][install-page] on the device running Paperback.
2. Add the repository, then install **Vortex Scans**.
3. In the extension settings, choose **Sign in to Vortex Scans** and complete Google or Discord sign-in.

Purchased chapters become readable after Vortex validates the session. Other paid chapters remain visibly locked and must be unlocked on Vortex Scans.

## Install From Source

```bash
git clone https://github.com/michaelasper/paperback-corruptbytes.git
cd paperback-corruptbytes
npm ci
npm run serve
```

Open the LAN URL printed by the development server on your Paperback device. The hosted repository is built from `main` and deployed to GitHub Pages automatically.

## Prerequisites

| Requirement    | Version or purpose                   |
| -------------- | ------------------------------------ |
| Paperback      | 0.9.x                                |
| Vortex account | Required only for purchased chapters |
| Node.js        | 24 or newer for local development    |

## Authentication and Privacy

Authentication stays on Vortex’s own sign-in page. The extension stores only first-party `vortexscans.org` cookies in Paperback secure state, never asks for a password, never creates a bearer token, and does not send session cookies to unrelated hosts.

## Development

```bash
npm ci
npm test
npm run test:live
npm run conformance
npm run bundle
```

The default suite is deterministic and offline-friendly. `npm run test:live` checks the current OAuth providers, anonymous account contract, catalog filters, one readable chapter, and one real locked chapter against Vortex; it never attempts a purchase.

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
