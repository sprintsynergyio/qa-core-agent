# QA-Core results, November 2026

The numbers behind QA-Core's public claims, from the last three graded runs. Every figure is copied from a run's `run-report.json` and its diagnosis under `docs/audit/`. Any public claim must trace back to this page.

## What was tested

- **Site:** Toolshop (testsmith-io/practice-software-testing at commit ae7caecb), a demo shop with a catalogue, cart, contact form and account pages, self-hosted for the runs.
- **Requirements:** one SRS document with 14 rules across 4 features, read into the same requirements map on every run.
- **Settings:** the same command every run, default models, a $6 cost ceiling, and a dedicated test account supplied through `.env`.
- **What each run does:** finds the pages, plans tests from the rules, records each test in a real browser, has a second model review every test, re-runs each one in a fresh browser (once, then three more times), and finally runs the written Playwright framework once before zipping it.

## Results

| | Run 8 (Nov 2) | Run 9 (Nov 17) | Run 10 (Nov 18) |
|---|---|---|---|
| Tests planned | 20 | 20 | 20 |
| Tests shipped in the framework | 10 | 18 | 16 |
| Shipped tests that passed the final framework run | not run | 17 of 18 (1 not run, safety cap) | 16 of 16 |
| Flaky tests across 3 stability re-runs | 0 of 10 | 0 of 17 | 0 of 18 |
| Rules covered, as the report counts them | 10 of 14 | 12 of 14 | 10 of 14 |
| The same rules, checked by hand | 5 fully, 2 partly | 5 fully, 5 partly, 2 not | 6 fully, 4 partly, 0 not |
| Product findings / of them, agent mistakes | 0 / 0 | 1 / 1 | 0 / 0 |
| Test account still signs in after the run | no | yes | no |
| Total cost | $6.20 | $4.73 | $5.87 |
| Run time, start to finish | 14 min 58 s | 12 min 8 s | not comparable (two processes, see below) |

Run 10 stopped on API credit after 17 tests and was resumed from its checkpoint; the resume ran every later stage. The $5.87 covers both parts.

## What did not work

- **Runs 8 and 10 locked the test account.** In run 10, the safety counter only counted a wrong-password test whose name contained "login", so it read 0 and the test ran 7 times against a site that locks after 3. Fixed in PR #68 and proven offline on a test site that locks the same way. No live run has confirmed the fix yet.
- **Some test names claim more than the test checks.** Run 10 has 3, for example "displayed products with names, images and prices", which never reads a name. Run 9 had 6.
- **The reviewer sent back 35 percent of run 10's tests for rework on the first pass** (run 9: 22 percent). Five of the seven were about tidier selectors or recordings; the repair pass kept 6 of the 7.
- **The report credited rules that no test checked** until PR #65. Run 9's report counted 12 rules covered where a hand check found 2 not checked at all. Run 10's report counts 10, and none of them is unchecked.

## Numbers safe to quote

- "Every test in the framework runs 5 times in fresh browsers before it ships: once in replay, three times in stability, and once as part of the written framework." True of every shipped test in run 10. A wrong-password test is the exception by design: it runs once in replay and once in the framework, so it does not lock the account (run 9's ran in replay only, its safety cap was spent).
- "On a 14-rule requirements document, QA-Core shipped 16 to 18 working Playwright tests per run, for $4.73 to $5.87." Source: runs 9 and 10.
- "0 flaky tests: every test stability re-ran passed all 3 re-runs, in runs 8, 9 and 10" (10, 17 and 18 tests).
- "The coverage report and a hand check agreed: no rule was reported covered without a test that checks it." Run 10 only, after PR #65.
- "Every number in the report is checked by hand against the recorded run." True of this page and the audit diagnoses.

Do not quote:

- A rule-coverage percentage as if it were full coverage (6 of 14 rules are fully checked in run 10).
- Any claim about client sites. All three runs are on one demo site.
- "It never locks accounts." The fix is proven offline, not yet on a live run.
- Run times for run 10.

## Evidence

- Run reports and frameworks: `output/localhost/20261102T*-71d739/`, `20261117T120141Z-b4e41b/`, `20261118T083203Z-ceeaf2/` (local, not committed).
- Diagnoses: `docs/audit/run-71d739-diagnosis.md`, `docs/audit/run-b4e41b-diagnosis.md`, `docs/audit/run-ceeaf2-diagnosis.md`.
- Bars written before each run, and their verdicts: STATE.md, "Run 8 bar", "Run 9 bar" and "Run 10 bar".
