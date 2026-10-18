---
name: verify-paperback
description: Verify paperback-corruptbytes source protocols, repository installation artifacts, account boundaries, and the Shiba theme. Use after source, dependency, theme, or release changes, and to investigate catalog or chapter failures. Distinguish live HTTP evidence from native Paperback verification.
---

# Verify Paperback sources

Read [the feature map](features/README.md) before choosing a drive. Run commands from the repository root in Bash. Read `package.json` and the selected `src/<Source>/live.test.ts` before execution if they changed.

The primary user surface is Paperback 0.9.x on iOS. This checkout supplies extensions, not the app. Its executable harnesses call public websites through production clients or parsers using Node request adapters. They cannot prove native rendering, installed-library state, or embedded-browser cookie handoff. The installation page and the external theme editor are additional surfaces. Report unavailable surfaces as unverified.

## Launch

Use Node 24 or newer. One owner may install dependencies or build a checkout at a time. Use separate worktrees with their own dependencies and output directories for concurrent builds. Do not install over another worker's linked `node_modules`.

Create separate evidence and disposable-state directories. Record their absolute paths and reuse those exact values in later tool shells.

```bash
export VERIFY_ROOT="$(git rev-parse --show-toplevel)"
cd "$VERIFY_ROOT"
export VERIFY_EVIDENCE="$(mktemp -d "${TMPDIR:-/tmp}/paperback-verify-evidence.XXXXXX")"
export VERIFY_SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/paperback-verify-scratch.XXXXXX")"
printf 'evidence=%s\nscratch=%s\n' "$VERIFY_EVIDENCE" "$VERIFY_SCRATCH"
{ git rev-parse HEAD; git status --short; node --version; npm --version; } > "$VERIFY_EVIDENCE/context.txt"
npm ci > "$VERIFY_EVIDENCE/install.log" 2>&1
install_status=$?
printf '%s\n' "$install_status" > "$VERIFY_EVIDENCE/install.exit"
test "$install_status" -eq 0 || exit "$install_status"
npm run bundle > "$VERIFY_EVIDENCE/build.log" 2>&1
build_status=$?
printf '%s\n' "$build_status" > "$VERIFY_EVIDENCE/build.exit"
test "$build_status" -eq 0 || exit "$build_status"
```

Run lengthy commands through the session's managed command monitor. Preserve exit codes and use completion notifications instead of shell polling loops. On failure, inspect the log, run Cleanup, and fix the cause before retrying with fresh directories.

Readiness is exit 0 from the build, `Packaged shiba.pbcolors.`, and `Verified 10 Paperback source bundles.`. Recount the sources if the manifest changes. A log line alone is insufficient; run Doctor.

The default protocol drive is short-lived and needs no local server, port, seed database, or credentials. To drive native installation, use the owned interactive server procedure in [installation](features/installation.md). Never start that server with closed stdin.

## Doctor

Run this read-only artifact check before a drive and whenever the build looks stale:

```bash
npm run verify:bundles > "$VERIFY_EVIDENCE/doctor.log" 2>&1
doctor_status=$?
printf '%s\n' "$doctor_status" > "$VERIFY_EVIDENCE/doctor.exit"
test "$doctor_status" -eq 0 || exit "$doctor_status"
```

It validates source IDs, versions, metadata, icons, JavaScript artifacts, and exact packaged theme bytes. It does not prove JavaScript freshness after source edits. If production files changed since Launch, rebuild before driving. For a server or browser, also perform the ownership/readiness check in its feature recipe. Never drive someone else's instance.

## Drive

For the baseline end-to-end protocol proof, drive [chapters and readers](features/chapters.md):

```bash
printf '%s\n' 'chapters.atsumaru: npm run test:live:atsumaru' > "$VERIFY_EVIDENCE/drive-command.txt"
npm run test:live:atsumaru > "$VERIFY_EVIDENCE/drive.log" 2>&1
drive_status=$?
printf '%s\n' "$drive_status" > "$VERIFY_EVIDENCE/drive.exit"
```

Read the log even when exit is 0. Require the named live tests to execute, not skip. The four-series diagnostics must show matching raw and retained chapter counts. Do not freeze upstream totals. Record the outcome before Cleanup, including failures.

For all sites, use `npm run test:live`. It enables all ten gates. `npm test` alone leaves live suites disabled. `npm run test:live:github` intentionally excludes MadaraDex; inspect its separate CI probe outcome. A green job with an advisory failure does not verify MadaraDex.

Live checks make real network requests and download bounded image samples. They are not dry runs. Never purchase content, bypass an access challenge, or change permissions to make a test pass. Keep an access block distinct from parser drift. An unexpected failure requires reproduction and triage, not an automatic skip or repeated retries.

## Evidence

Keep evidence in `$VERIFY_EVIDENCE`, outside the checkout and outside disposable state. Record the revision, dirty-file status, command, feature ID, stdout, stderr, and exit code. Add the affected public series/chapter IDs for a bug report. Do not record cookies, authorization headers, credentials, account response bodies, or private backups.

Prove the selected user path. Live adapters may replace Paperback scheduling with Node HTTP, but must retain the production client/parser and assert observable returned IDs, ordering, ratings, pages, or errors. Do not substitute internal setters or a fabricated successful response for an external behavior claim.

For UI work, capture the action and resulting state, screenshots, browser/app version, and downloaded or persisted files. Use real file pickers and downloads. Verify their contents, not just a success message. Fixtures can prove isolated boundary behavior; label them offline and do not count them as live or native evidence.

Report each mapped entry point as PASS, FAIL, BLOCKED, or NOT RUN. A single passing entry point does not cover the rest of its feature map. Native absence is NOT RUN. An attempted request stopped by access control is BLOCKED.

## Cleanup

Run cleanup after successful and failed attempts. Protocol test processes terminate themselves and restore their process-local Application adapter. There is no daemon to kill for the baseline drive.

For instances you started, close only the owned browser context and stop only the recorded terminal or monitor. The toolchain server accepts `stop` on its own terminal. Never use `pkill`, a process name, or an unverified reused PID. Confirm its listener is gone before removing its disposable checkout/profile.

After confirming `$VERIFY_SCRATCH` is the run-owned directory printed by Launch and is distinct from the evidence directory:

```bash
rm -rf -- "$VERIFY_SCRATCH"
test ! -e "$VERIFY_SCRATCH"
test -s "$VERIFY_EVIDENCE/context.txt"
test -s "$VERIFY_EVIDENCE/doctor.log"
test -s "$VERIFY_EVIDENCE/drive.log"
test -s "$VERIFY_EVIDENCE/drive.exit"
```

For another mapped drive, check its named evidence files instead. Retain failure logs too. Do not remove `$VERIFY_EVIDENCE`, the user's library, existing profiles, or unrelated generated output. Report the surviving evidence path.

## Helpers

No new helper scripts or browser dependencies are shipped with this skill. Reuse these checked-in entry points:

- `npm run bundle` packages extensions and Shiba.
- `npm run verify:bundles` performs Doctor.
- `npm run test:live:atsumaru` performs the baseline drive.
- `npm run test:live` exercises every source gate.
- `npm run test:live:random` probes nine sources, not Rokari. Record `LIVE_RANDOM_SEED`, `LIVE_RANDOM_SAMPLES`, and `LIVE_RANDOM_CONCURRENCY` for replay. It makes real requests.
- `node scripts/shiba-theme.mjs verify-published` checks a deployed theme. Supply both published environment variables as shown in [the theme recipe](features/theme.md).

See [installation](features/installation.md) for immutable CI-artifact verification. Keep this map current with `/skill:maintain-verification-skill` when that companion skill is available.
