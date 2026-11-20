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

### Removed

- Local tooling and working files are no longer tracked: `STATE.md`, `.mcp.json`, `.claude/`, `.openclaw/config.json` and `.playwright-mcp/`.
- Before and after screenshot sets under `docs/ui/` that nothing links to.

### Security

- `npm audit --omit=dev` reports 0 vulnerabilities (it reported 1 critical, 4 high and 4 moderate before).
