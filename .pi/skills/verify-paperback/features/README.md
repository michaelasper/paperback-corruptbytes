# Paperback verification map

Read this index before driving a feature. The primary surface is the Paperback iOS app. Node live contracts exercise public source protocols, not native UI. Browser checks cover repository downloads and the theme editor separately.

## Preconditions

Run Launch and Doctor in [the skill](../SKILL.md). Preserve the same `VERIFY_ROOT`, `VERIFY_EVIDENCE`, and `VERIFY_SCRATCH` across tool shells. Build in a singly owned checkout. Use a fresh browser context for editor work and an explicitly assigned device/profile for native work. Do not alter the user's library to manufacture a passing state.

## Features

| Feature                                     | Entry points                                                          | Automated evidence                                                    | Remaining native proof                                |
| ------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------- |
| [Installation](installation.md)             | Published repository, local LAN repository, refresh                   | Built and deployed manifests/artifacts                                | Add repository, install/update, source visibility     |
| [Discovery and search](discovery-search.md) | Home rails, title search, genre, sorting, pasted URL                  | Named source live contracts                                           | Each app entry point and resulting cards              |
| [Chapters and readers](chapters.md)         | Details, existing library, alternate translations, comic/novel reader | Raw-to-client chapter integrity, page/paragraph order, image requests | Persisted progress, native decode/render and refresh  |
| [Account access](account-access.md)         | Source settings, sign-in, challenge, locked chapter, logout           | Anonymous/locked live checks and offline boundary tests               | Embedded-browser handoff and authorized account state |
| [Shiba theme](theme.md)                     | Direct download, editor import/export, light/dark, app import         | Schema/contrast/byte checks and browser actions                       | Paperback import and artwork-backed materials         |

## Proof standards

Record the feature and entry point with the command or UI action and resulting state. Capture stdout/stderr and the exit code for commands. Capture screenshots and resulting files for browser actions. Redact private account information. Keep evidence after teardown.

PASS applies only to the named path. FAIL means observed behavior contradicted the contract. BLOCKED means a prerequisite or access control prevented the attempted drive. NOT RUN means the path was not exercised. An HTTP 403 is not a successful locked-chapter test unless that test explicitly asserts the site's authorization decision for the requested chapter.

Each feature file has four sections. Maintain its sub-feature IDs, user entry points, harness instructions, and gotchas together. When a public protocol changes, update the corresponding `src/<Source>/live.test.ts` and this map rather than copying transient counts into the documentation.
