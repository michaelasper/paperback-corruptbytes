# Repository Guidelines

## Project Structure & Module Organisation

Extensions live in `src/<ExtensionName>/`. Separate entry points, clients, networking, parsing, authentication, search, and settings by module. Co-locate `*.test.ts` and `test-fixtures.ts`; place icons in `static/`. Reusable URL, HTTP, HTML, ID, cache, and cookie logic belongs in `src/shared/`. Release checks live in `scripts/`. Rebuild `bundles/`; never edit generated output.

## Build, Test, and Development Commands

Use Node.js 24+ and install with `npm ci`.

- `npm test`: run deterministic source and release-contract tests.
- `npm run conformance`: check types, lint, formatting, and version bumps.
- `npm run bundle`: build and validate every extension.
- `npm run dev`: start the Paperback server in watch mode.
- `npm run test:live:atsumaru`: exercise one live contract; `npm run test:live` covers all sites.

## Coding Style & Naming Conventions

Use strict ESM TypeScript, two-space indentation, `.js` relative-import suffixes, and `import type`. Use PascalCase for extension directories and classes, camelCase for symbols, and `UPPER_SNAKE_CASE` for constants. Run `npm run format` and `npm run lint`; CI uses `*:check`. Preserve URL, response-size, cookie-origin, and content-sanitisation boundaries.

## Testing Guidelines

Tests use `node:test` through `tsx`. Name tests after observable behaviour. Bug fixes and parser changes need deterministic regression tests. Update `live.test.ts` for public protocol changes; keep ordinary tests offline. Run the closest suite, then `npm test` and `npm run conformance`.

## Agent Working Agreement

Follow [OpenAI's prompting best practices](https://developers.openai.com/api/docs/guides/latest-model#prompting-best-practices). Keep execution context lean: state instructions once, inspect relevant files, and use task-relevant tools. Establish the outcome, hard constraints, required evidence, and success criteria before editing.

- For answers, explanations, reviews, diagnoses, or plans, inspect and report; do not implement unless asked.
- For changes, builds, or fixes, make in-scope local edits and run relevant non-destructive validation without asking first.
- Ask before external writes, destructive or costly actions, purchases, or material scope expansion.

Reading files, inspecting logs, editing in-scope code, and running tests are safe local actions. Continue until the success criteria are met or a concrete blocker remains. Lead final reports with the outcome, verification, material caveats, and next action; omit repeated background and generic reassurance.

## Commit & Pull Request Guidelines

Use short, imperative, sentence-case subjects such as `Fix source ID encoding`. Keep commits focused. Production changes must advance the affected `pbconfig.ts` semantic version. Pull requests should describe behaviour, affected sources, linked issues, and verification commands. Add screenshots only for visible UI changes; never include credentials, cookies, or private response data.
