# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Pages behind a sign-in. With a test account in the environment, discovery signs in once and looks for the pages the sign-in opens (the account page, a profile, invoices). Each one is planned from its signed-in snapshot, reached by the sign-in and a click, and never opened by its URL. The console prints one `Login probe:` line that also names the pages behind the sign-in that no requirements feature covers. With no test account, a feature that names an account page is recorded as not looked for, with the reason.
- Account safety behind the sign-in: a test that would change the test account's password or sign-in email, or delete the account, is never planned, and the tool refuses the step if one is recorded anyway.
- `scripts/probe-login.ts <url>`: runs discovery and the login probe alone, with no model call and nothing written, and prints the pages a run would find behind the sign-in.
- `smoke-login-action`: a fixture site with pages behind a login, the probe, the plan, the tools, the emitted framework run with Playwright in TypeScript and JavaScript, and a whole run in process.
- Claims and evidence. A test name is now checked against its own recording before the test is accepted: if the name says a name, a price, an image, a total, a quantity or a count is shown, matched or updated, or that something was rejected or an error was shown, the recording must hold a check that proves it. The first refusal tells the model what is missing and keeps the scenario open; the second drops the scenario with the reason. Run 10 shipped three such names. When a rule the test cites says more than the test checks, the model is asked once to add that check; the test is kept either way.
- Rule coverage counts a rule as covered only when a shipped test that cites it checks what the rule says. A rule that is cited and only partly checked reads `cited-not-exercised`, with the tests that cite it and the part no test checks. Coverage numbers go down where the old count was too kind: run 10 reads 7 of 14 where its report said 10.
- `scripts/claim-check.ts <run dir>`: prints, for any stored run and with no model call, the test names and the covered rules that the recordings do not back.
- `smoke-claim-evidence`: the vocabulary, run 10's own recordings, the tool on a fixture site, and the doctrine in both prompts.
- Rule placement. After every page is planned, a requirement that no planned test cites is planned on a page that shows what the requirement needs, with one small planning call for that rule. A search rule goes to the page that has the search box and a rule that names the home page goes to the home page, whatever feature tag the page filter gave those pages. At most five such calls per run. When the plan is full, the new test replaces a planned test that cites no rule, and the console names the one it replaced.
- The run report records every rule the placement pass looked at (`rulePlacements`): where it was planned, or why it could not be.
- `smoke-rule-placement`: the placement decision, the planning loop, the one-rule call, rule coverage, three served pages and a whole run in process.
- Accessibility findings. Every run now scans its pages with axe (WCAG 2 A and AA), signed out and with no model call, and records each rule broken at critical or serious impact as product behavior to review: the rule, its impact, how many elements, on which pages, and a link to the rule. The run report carries the scan (`accessibility`), the console prints it, the dashboard shows an "Accessibility to review" section on the run page, and the findings list tags these rows "Accessibility". They count in To review and never in the test funnel. Pages reached only by an action, pages behind a sign-in and generated-id pages are not scanned and are named. A page that fails to scan is recorded with its error and never reads as clean.
- `scripts/a11y-scan.ts <url> [more urls]`: runs the accessibility scan alone, with no model call and nothing written.
- `smoke-a11y-findings`: the scan on a served site, a whole run in process, the index, the API and the dashboard in both themes.

### Fixed

- The login probe now says when robots.txt is the reason a page behind the sign-in was not opened, and names the rule. It used to list such pages as "not opened" with no reason.

### Changed

- "Needs attention" on a run page now counts accessibility findings beside product findings and uncovered rules. A run from before the scan reads as before.
- The index schema is at version 9: `findings.source` (`scenario` or `a11y`), added in place with existing rows kept.
- Rule coverage has a new reason, `cited-not-exercised`. The dashboard's rule table shows it as "cited, not fully checked".
- Rule coverage has two more reasons. A rule whose test was skipped reads `planned-but-skipped` with the reason the run recorded, where it used to read `planned-but-dropped` with no reason. A rule whose test ended as a finding reads `finding-recorded`. The dashboard shows them as "planned, skipped" and "finding recorded".
- A rule that could not be planned on any page now says why (for example, no planned page has a search box), where it used to read `not-planned` with nothing more.
- A click-through test whose name says the price is the same on both pages is no longer planned on a page that shows no price.
- A test name that says a "required-field message" was shown is no longer dropped at plan time as if it named a message field.
- An emitted test that signed in first now opens the page the browser was on after the sign-in. A test of the page the sign-in lands on keeps its checks; it was emitted as an empty test before.

### Not built yet

- A link inside a menu that is closed until clicked is not seen by the login probe.
- A page that needs both an item in the cart and a sign-in is not reached.

## [0.3.0] - 2026-11-20

Release readiness. Not tagged yet.

### Added

- MIT licence, package metadata, and this changelog.
- `npm run lint`: ESLint flat config for the TypeScript in `src/` and `scripts/`.
- CI runs the whole smoke suite on Node 22 and Node 24, after typecheck, lint and the dashboard build. The live smokes stay skipped.
- More checks in `smoke-zip` for the in-process zip: no `zip` command needed, forward-slash entry names, the renamed root folder, the exclude patterns, permission bits and a symlink loop.
- `smoke-mcp-version`: starts the real MCP server, connects a client over stdio and checks that the version it reports equals `package.json`'s.
- The suite runner lists every `FAIL` line of a failed smoke, whole, before the last 20 lines of output. The tail alone could hide the failing check (`smoke-runner-report`).

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

### Fixed

- Settings page: a long output root (a path with no spaces) wraps inside its box. It made the page scroll sideways, at phone width on macOS and at any width for a long enough path. `smoke-design-system` now uses a long fixture path on every machine, so Linux CI sees what a Mac sees.

### Removed

- Local tooling and working files are no longer tracked: `STATE.md`, `.mcp.json`, `.claude/`, `.openclaw/config.json` and `.playwright-mcp/`.
- Before and after screenshot sets under `docs/ui/` that nothing links to.

### Security

- `npm audit --omit=dev` reports 0 vulnerabilities (it reported 1 critical, 4 high and 4 moderate before).
- Dashboard package: `npm audit fix` raised source-map-js (high) and postcss-selector-parser (moderate) in the lockfile. `npm --prefix dashboard audit --omit=dev` now reports 2 moderate, both react-router 6, fixed only by react-router 7. Left on purpose, with two dev-only items: vite 5 in the dashboard (high, dev server only, fixed by vite 8) and esbuild in the root package (low, dev server on Windows only).
