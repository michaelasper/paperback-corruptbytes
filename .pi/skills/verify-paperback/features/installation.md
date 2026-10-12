# Install and refresh sources

Readers add the repository to Paperback, install a source, and refresh it after a release. Repository delivery and native installation require separate proof.

## Sub-features

- `install.published` downloads current repository metadata and artifacts.
- `install.local` serves a candidate on a trusted LAN.
- `install.refresh` updates an installed source without changing its library identity.
- `install.visibility` respects the Paperback profile's content level.

## How to get to it (user POV)

Open `https://michaelasper.github.io/paperback-corruptbytes/` on the Paperback device and use its repository installation action. Install or update the chosen source in Paperback. For local development, open the LAN URL printed by the toolchain server on that device. Refresh the repository after deployment finishes. Check the profile's allowed content level if a source is hidden.

## Driving it with the repository CLI and HTTP

Preconditions: Launch and Doctor passed. For local native work, own the device session and an interactive terminal. For published proof, identify a completed push CI run for the exact release SHA.

- Build proof. Read `bundles/versioning.json` and `bundles/Atsumaru/info.json` for the baseline source. Run `npm run verify:bundles` and record its exit code. This proves artifact contracts, not app installation.
- Local entry. Check port 18080 is free with `lsof -nP -iTCP:18080 -sTCP:LISTEN`. A missing `lsof` is not proof the port is free. Start `npm run serve -- --port 18080` in an owned interactive terminal with stdin kept open. Do not pass device reinstall flags or watch mode for the baseline. Record the terminal/monitor ID. Require `Server running at http://127.0.0.1:18080/` and verify listener ownership, then fetch `curl --fail --silent --show-error http://127.0.0.1:18080/versioning.json` into the evidence directory. Compare it with the current on-disk manifest. Stop with `stop` in that same terminal, then verify the listener disappeared.
- Published entry. Wait for the push workflow to finish. Inspect `gh run list --branch main --json databaseId,headSha,event,status,conclusion,url` and select the exact push SHA, not merely the latest green run. Download its `github-pages` artifact with `gh run download "$VERIFY_RUN_ID" --name github-pages --dir "$VERIFY_EVIDENCE/ci-artifact"`. Set `VERIFY_RUN_ID` to that observed numeric ID and `VERIFY_RELEASE_SHA` to its observed `headSha`. Extract only the expected manifest with `tar -xOf "$VERIFY_EVIDENCE/ci-artifact/artifact.tar" ./versioning.json > "$VERIFY_EVIDENCE/expected-versioning.json"`.
- Verify delivery. Run the following from the checkout for that release. Capture the command, exit code, and output as `published-sources.log`. A pass verifies manifest and metadata equality, plus bundle and icon availability, bounded size, and content type. It does not compare JavaScript or icon bytes with the CI artifact.

```bash
PUBLISHED_EXPECTED_MANIFEST_BASE64="$(base64 < "$VERIFY_EVIDENCE/expected-versioning.json" | tr -d '\n')" \
PUBLISHED_REPOSITORY_URL=https://michaelasper.github.io/paperback-corruptbytes/ \
PUBLISHED_RELEASE_KEY="$VERIFY_RELEASE_SHA" \
  npm run verify:published > "$VERIFY_EVIDENCE/published-sources.log" 2>&1
result=$?
printf '%s\n' "$result" > "$VERIFY_EVIDENCE/published-sources.exit"
```

- Native entry. With an available device driver, capture opening the repository link, the install/refresh action, and the resulting installed source/version. Reopen an existing library title and compare its ID and progress. Record app version and content-profile setting without personal data. If no device driver is available, report these native paths NOT RUN.

## Gotchas

- `serve` rebuilds bundles through the toolchain, not the repository's Shiba packaging command. Do not treat it as theme packaging proof. Run `npm run bundle` after stopping it when theme artifacts are needed.
- The server listens on network interfaces, not only loopback. Use a trusted network. Do not expose it to the Internet.
- The server's interactive input loop is not safe to launch with closed stdin. Use an owned PTY; otherwise skip local serving and use one-shot artifact checks.
- Local server URLs must not carry release query parameters. The toolchain treats the query as part of the file path.
- A separately rebuilt local manifest has a different `buildTime`. Use the immutable CI artifact as the published-source oracle, never the downloaded website's own manifest.
- Push and manual CI runs share a concurrency group. Finish deployment before dispatching a manual live run, or the latter can cancel deployment. A manual run does not deploy Pages.
- Never kill another listener or uninstall the user's source to free an instance. A public artifact check does not establish native installation or profile visibility.
