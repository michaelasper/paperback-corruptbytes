# Changelog

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
