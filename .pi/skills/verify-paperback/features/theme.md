# Shiba theme

Readers download one `.pbcolors` file, preview or edit its light/dark variants, and import it into Paperback. The checked-in file is the palette source; the build copies it without generating another color format.

## Sub-features

- `theme.download` retrieves the exact released file with the expected filename.
- `theme.import` loads all 20 roles through the editor's file picker.
- `theme.modes` renders distinct light/dark colors and preserves unlinked edits.
- `theme.export` downloads an equivalent theme and supports reimport.
- `theme.native` imports and renders the theme inside Paperback.

## How to get to it (user POV)

Use the Shiba download link in the repository README at `https://michaelasper.github.io/paperback-corruptbytes/shiba.pbcolors`. Open `https://theme.pirate.vodka/`, choose Import, select the file, and choose Show preview. Switch Light and Dark. Turn off Modes linked before changing one variant. Export with the name `shiba`. Use the actual theme-import control in the available Paperback build; inspect its UI rather than inventing app navigation.

## Driving it with artifact checks and browser automation

Preconditions: Launch and Doctor passed. For a deployed check, use the checkout for the intended release and set `VERIFY_RELEASE_SHA` to its verified commit. For UI proof, have an owned browser automation context with downloads enabled. If no browser driver is available, run artifact checks and report browser/native paths NOT RUN. Do not depend on a previous agent's temporary scripts or installed browser packages.

- Local artifact. Run `node --test scripts/shiba-theme.test.mjs scripts/release-contract.test.mjs > "$VERIFY_EVIDENCE/theme-tests.log" 2>&1` and record its exit code. Run `cmp themes/shiba.pbcolors bundles/shiba.pbcolors` and record the result. These checks cover schema, supported contrast pairs, packaging, and release contracts, not visual rendering.
- Published artifact. Run the command below after Pages succeeds. Download the same public URL through the browser and save its actual download under the evidence directory. Require filename `shiba.pbcolors` and byte equality with the release's `themes/shiba.pbcolors`.

```bash
PUBLISHED_REPOSITORY_URL=https://michaelasper.github.io/paperback-corruptbytes/ \
PUBLISHED_RELEASE_KEY="$VERIFY_RELEASE_SHA" \
  node scripts/shiba-theme.mjs verify-published > "$VERIFY_EVIDENCE/theme-published.log" 2>&1
result=$?
printf '%s\n' "$result" > "$VERIFY_EVIDENCE/theme-published.exit"
```

- Import. Navigate the owned browser to the editor. Start waiting for its real file-chooser event, click `#btn-import`, and supply the actual built or downloaded file. Do not inject editor state. Require 20 `.color-row` elements, then click `#btn-preview-toggle`. Record editor URL/revision when available and browser version.
- Modes. Click `#btn-light` and `#btn-dark`. Wait for `.preview-v09[data-preview-mode="light"]` or `.preview-v09[data-preview-mode="dark"]`. Require no `.preview-v09-missing` panels. Capture each scene at desktop and narrow mobile widths. Scene selectors are `section[aria-labelledby="preview-v09-discovery"]`, `preview-v09-filters`, `preview-v09-details`, `preview-v09-chapters`, `preview-v09-reader`, and `preview-v09-settings` using that same attribute-selector form. On mobile use `#btn-mobile-colors` before selecting a mode and `#btn-mobile-preview` to return.
- Visible state. Check `.preview-v09-canvas` and `.preview-v09-continue` computed backgrounds against the imported palette in both modes. Capture Continue/NEW labels, secondary buttons, included/excluded tags, completed chapters, and reader settings. Save screenshots alongside the imported file and action log.
- Export. Click `#btn-export`, set `#export-name` to `shiba`, start waiting for a real download, and click `#export-form .export-confirm`. Save the download. Require its suggested filename to be `shiba.pbcolors` and parsed JSON to equal the imported source. Reimport that exported file and repeat both modes. Compare semantic JSON here because the editor can change formatting.
- Unlinked edit. In a separate disposable run, import the original, select Light, click `#btn-global-link` to disable linking, and edit the text input inside `.color-row[data-color="accent"]` to `#9D3D0A`. Blur the input. Export and require only the light accent red channel to change to `157 / 255`, with dark values preserved. Reimport the original before final screenshots. Inspect the button's class/title and exported values, not only its ARIA state.
- Native entry. With an available device driver, import the downloaded file and capture actual light/dark screens, completed rows, and artwork-backed materials. Record the app version. No native driver means NOT RUN, even if browser checks passed.

## Gotchas

- The extension is `.pbcolors`, not `.pbcolor`. The file has 20 roles, even though the upstream editor README historically said 17.
- Consult `https://github.com/LucifersCircle/theme-editor` when selectors or role mappings change. An importer accepting a file does not replace strict local schema checks.
- The editor preview currently maps 15 roles and leaves five unresolved. Completed rows apply 50% opacity. Numeric token contrast and browser previews do not prove native accessibility.
- Import resets actual mode linking. After an earlier unlink, the editor can leave its ARIA label stale; exported values are the proof.
- The theme verifier accepts the deployed extension's MIME type but requires exact source bytes. Never relax the check to accept an HTML fallback or merely parseable stale colors.
- Close only the browser context created for this drive. Remove its disposable profile, not evidence downloads or screenshots. Real iOS Safari and Playwright WebKit are different verification claims.
