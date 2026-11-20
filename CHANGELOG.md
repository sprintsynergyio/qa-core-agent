# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] - 2026-11-20

Release readiness. Not tagged yet.

### Added

- MIT licence, package metadata, and this changelog.
- `npm run lint`: ESLint flat config for the TypeScript in `src/` and `scripts/`.
- CI runs the whole smoke suite on Node 22 and Node 24, after typecheck, lint and the dashboard build. The live smokes stay skipped.
- More checks in `smoke-zip` for the in-process zip: no `zip` command needed, forward-slash entry names, the renamed root folder, the exclude patterns, permission bits and a symlink loop.
- `smoke-mcp-version`: starts the real MCP server, connects a client over stdio and checks that the version it reports equals `package.json`'s.

### Changed

- Node 22 or newer is required (`engines`), and Node 24 is supported.
- Framework zips are built in process with `adm-zip`. The agent no longer shells out to the `zip` command, which Windows does not have. Windows as a whole is not tested yet.
- `npm test` runs the smoke suite. The old behaviour (Playwright against generated specs in `output/`) is `npm run test:specs`.
- `better-sqlite3` 11 to 12, which downloads a prebuilt binary for Node 22 and Node 24. Version 13 was tried and left: npm 10 and 11 build it from source when they install from a lockfile.
- `qa-core-heal` 0.3.4 to 0.7.2.
- `@anthropic-ai/sdk` 0.32 to 1.11.
- `@modelcontextprotocol/sdk` 1.30 to 1.32 and `zod` 3 to 4.
- The project lives at `github.com/sprintsynergyio/qa-core-agent`. Package metadata, the README, the docs and the README written into every generated framework point there.
- The project is published by SprintSynergy: package author, licence copyright and the "About SprintSynergy" section of the README.
- The MCP server reports the version in `package.json`, read at runtime through one helper (`src/agent/package-version.ts`). It reported 0.4.0 from two hard-coded strings while the package was 0.3.0.
- The smoke suite and `scripts/credential-leak-scan.ts` read, extract and write zips in process (`scripts/lib/zip-read.ts`, adm-zip). They no longer call the system `zip` or `unzip`, and CI no longer installs them. One optional cross-check in `smoke-zip` still opens an archive with the system `unzip` when one is on PATH, and says so when none is.
- `scripts/credential-leak-scan.ts` names every zip it could not read and no longer prints a plain "no hits" in that case.
- The Critic's step rendering no longer throws on an assertion type it does not know: it writes `assert <type> (no rendering)` and logs one warning per type, so a checkpoint written by another version cannot stop a resumed run.
- OpenClaw is described as an optional integration. The README no longer says the project is distributed through it.
- CLAUDE.md describes `.mcp.json` and `.claude/skills/` as optional local files that each contributor creates and git ignores.

### Removed

- Local tooling and working files are no longer tracked: `STATE.md`, `.mcp.json`, `.claude/`, `.openclaw/config.json` and `.playwright-mcp/`.
- Before and after screenshot sets under `docs/ui/` that nothing links to.

### Security

- `npm audit --omit=dev` reports 0 vulnerabilities (it reported 1 critical, 4 high and 4 moderate before).
- Dashboard package: `npm audit fix` raised source-map-js (high) and postcss-selector-parser (moderate) in the lockfile. `npm --prefix dashboard audit --omit=dev` now reports 2 moderate, both react-router 6, fixed only by react-router 7. Left on purpose, with two dev-only items: vite 5 in the dashboard (high, dev server only, fixed by vite 8) and esbuild in the root package (low, dev server on Windows only).
