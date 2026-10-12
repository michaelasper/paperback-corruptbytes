# Account access and challenges

Readers can sign in to supported sources, resolve first-party verification, and read content the site permits. A locked chapter must not become fabricated pages.

## Sub-features

- `account.anonymous` reads public content without importing a user session.
- `account.sign-in` transfers permitted first-party cookies from the embedded browser.
- `account.locked` rejects chapters the site reports as inaccessible.
- `account.challenge` reports verification requirements without caching a wall as metadata.
- `account.logout` clears account state without leaking cookies to image hosts.

## How to get to it (user POV)

For Thunder Scans, Qi Manga, Valir Scans, Diva Scans, or Vortex Scans, open source settings and its sign-in action. Authenticate only with an authorized test account through the first-party embedded page, return to the account/profile page, and select Done. Open a chapter the account already owns and one the site marks locked. Use the source's logout action afterward only in the disposable account/profile assigned to this run. MadaraDex uses anonymous reader authorization instead of a user account.

## Driving it with live contracts and boundary tests

Preconditions: Launch and Doctor passed. Anonymous checks need no credentials. Native account checks need an explicitly assigned test account and device driver; otherwise mark them NOT RUN. Never borrow the user's existing session.

- Anonymous and locked. Run `VORTEX_LIVE_TESTS=1 ./node_modules/.bin/tsx --test src/VortexScans/live.test.ts > "$VERIFY_EVIDENCE/account-vortex.log" 2>&1` and `npm run test:live:diva > "$VERIFY_EVIDENCE/account-diva.log" 2>&1`. Record each exit code immediately. Require public-reader success and the explicit locked-reader rejection cases, not an unrelated transport error.
- Temple challenge. Run `npm run test:live:temple > "$VERIFY_EVIDENCE/account-temple.log" 2>&1`. Preserve failure output. The observed local wall produces `CloudflareError` with a trusted root resolution request before metadata/chapter caching. GitHub runners can instead receive HTTP 403. Neither result proves that native verification can complete the wall.
- Cache retry and false positives. Run `./node_modules/.bin/tsx --test src/TempleToons/network.test.ts src/shared/cookies.test.ts > "$VERIFY_EVIDENCE/account-boundaries.log" 2>&1`. Require ordinary widget pages to remain ordinary content, failures to retry, and cookie-origin boundaries to hold. These fixtures are offline proof only.
- Anonymous authorization. Run `npm run test:live:madaradex > "$VERIFY_EVIDENCE/account-madaradex.log" 2>&1`. Require the anonymous authorization and first CDN-image case to pass. An HTTP 403 from the runner is BLOCKED, not successful authorization.
- Native account path. Drive the actual sign-in, Done, owned-chapter open, locked-chapter rejection, and logout actions in the assigned profile. Capture redacted before/after state and verify a second reader attempt after logout. Do not log cookies or passwords. If the embedded view cannot complete the site's authentication method, record the limitation rather than changing credentials or bypassing it.

## Gotchas

- The live adapters do not establish native cookie import, passkey handoff, or logout persistence. Do not infer them from fixture tests.
- No purchase, unlock, or new account entitlement is part of this verification.
- Do not automatically rerun a challenged request until it passes. Distinguish access blocks from changed response formats using public status, final host/path, and safe diagnostics.
- A green GitHub workflow can include failed advisory MadaraDex and Temple probes. Read their logs and warnings individually.
