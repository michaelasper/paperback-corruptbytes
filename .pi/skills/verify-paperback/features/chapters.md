# Load chapters and read

Readers open a title from discovery or their existing library, choose a chapter or scanlation, and read ordered comic pages or novel paragraphs. Existing IDs and progress must survive a refresh.

## Sub-features

- `chapters.atsumaru` retains complete current chapter identities and backfills.
- `chapters.alternates` preserves scanlation variants or selects deterministic winners when disabled.
- `chapters.history` traverses multi-page histories instead of returning the first page only.
- `reader.comic` returns ordered safe image URLs with reachable sampled images.
- `reader.novel` preserves paragraph order and sanitizes HTML.
- `reader.library` opens a legacy library ID without replacing library identity or progress.

## How to get to it (user POV)

Open a series from source search or an existing library entry. Refresh the chapter list. For Atsumaru, change the alternate-translations setting and compare the list. Open early, middle, and latest available chapters. Open a novel as well as a comic. Revisit an existing library entry after refresh to inspect its reading progress.

## Driving it with live client contracts

Preconditions: Launch and Doctor passed. Use anonymous public fixtures, not the user's private library. The baseline Drive block in the skill captures this exact run and its exit code.

- Atsumaru complete path. Run `npm run test:live:atsumaru > "$VERIFY_EVIDENCE/drive.log" 2>&1`, then immediately record `$?` in `drive.exit`. Require the test `retains raw chapter IDs, order and reader content across four bounded series` to execute and pass. Its diagnostic rows cover IDs `68Fv`, `N7JpR`, `oJQ4o`, and `-aOD`. Each raw/retained count must match. The test compares IDs, chapter numbers, dense indices, since-date retention, and alternate collapse, then early/middle/latest reader contents and first/last image responses.
- Legacy identity. In the same run, require `resolves a legacy library ID to the affected title's complete current chapter range` and `preserves library IDs, detail posters, and chapter variants`. These exercise client identity behavior, not real persisted app storage.
- Alternate selection. Run `./node_modules/.bin/tsx --test src/Atsumaru/client.test.ts src/Atsumaru/parsers.test.ts > "$VERIFY_EVIDENCE/alternates-offline.log" 2>&1`. Require exact winner IDs for timestamp ties, zero/fractional chapter numbers, and backfills. Label this offline evidence.
- Paginated histories. Run `npm run test:live:qimanga` and `npm run test:live:rinko`, saving separate logs and exit codes. Require the complete multi-page history and fresh-nonce pagination cases. Do not infer completeness from a nonempty first page.
- Novel rendering contract. Atsumaru's live run checks escaped XHTML. `npm run test:live:valir` adds a public novel and distinct public/internal slug coverage. Successful sanitized HTML is not a native layout test.
- Native symptom. With an available device driver, repeat the reported public title/chapter in the installed source. Record source version, exact public IDs, alternate setting, list refresh versus reader-open action, visible page sequence, and persisted progress. If no device is available, state that the intermittent native symptom was not reproduced rather than claiming the API test fixed it.

## Gotchas

- Atsumaru `totalChapterCount` is not the count of every translation record. Compare raw unique IDs with client IDs; do not compare variant count with the page's total.
- Keep zero, fractional, alternate, and backfilled chapters. Do not deduplicate by chapter number in the default alternate-enabled path.
- Image MIME and completed byte downloads do not prove visual decoding or image quality in iOS. The current live probe samples first/last images and caps each at 2 MiB.
- Fixed fixture totals drift as sites publish. Require current raw-to-client agreement, not historical totals from an earlier report.
- Missing permission or an access wall is BLOCKED. Do not synthesize pages or change locked-content decisions.
