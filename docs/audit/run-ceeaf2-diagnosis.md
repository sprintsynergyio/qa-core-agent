# Diagnosis of run ceeaf2 (self-hosted Toolshop, 2026-11-18)

Run directory: `output/localhost/20261118T083203Z-ceeaf2/`, read through the desktop link at $0. Files read: `run-report.json`, `events.jsonl`, `console.log`, `discovery.json`, `rule-coverage.json`, `run-meta.json`, and the framework zip (unpacked; every spec, `playwright.config.ts` and `README.md`). Compared against run 9 (`docs/audit/run-b4e41b-diagnosis.md`) on the same benchmark. QA-Core source read where a defect needed it: `src/agent/test-credentials.ts`, `src/agent/checkpoint.ts`, `src/agent/explore-request.ts`.

The run had two parts. The first process (console of the owner, Nov 18 13:32) planned 20 scenarios, recorded 17, and stopped in the Explorer on API credit exhaustion ($3.7761 spent, `Run stopped: billing/credit exhaustion`). The bar says a stop before the Critic is not graded and the owner decides whether a second attempt counts as run 10; the advisor decided the resume counts (the stop was billing, not the engine, and the checkpoint exists for exactly this), and the owner ran it. The resume command repeated `--ceiling 6 --replay --stability 3 --stabilize --stabilize-attempts 3`, because a checkpoint restores lang, pom, features, srs, discover and urls only (`applyCheckpointFlags`, `explore-request.ts`); the printed hint `npm run explore -- --resume <path>` would have resumed under the $2.00 default ceiling with $3.78 already spent and without replay or stability (D5). The resume restored 17 scenarios, explored the remaining 3, and ran every later stage.

`cost.models` reads exactly the bar's models (requirements, featureParser, pageFilter and planner `claude-haiku-4-5`; explorer `claude-opus-4-7`; critic and stabilizer `claude-sonnet-4-6`). The map was reused (`requirements map: reused (ac278ddf17eb)`). The preflight signed in before any spend in both processes. Total cost $5.8701 (planner $0.0528, explorer $5.6766 of which repair $1.3129, critic $0.1407, stabilizer $0), under the $6 ceiling.

## 1. The bar and its grade

The bar, written Nov 18 before the run (STATE.md, "Run 10 bar", part d).

| Bar line | Run 10 | Run 9 | Grade | Read from |
| --- | --- | --- | --- | --- |
| 1. Rework rate under 35 percent on the first Critic pass | 35.0 percent (7 rework of 20) | 22.2 percent | MISSED | `review.repair` has 7 entries; the first `critic_done` event holds 20 verdicts (12 pass, 7 rework, 1 reject); no first-pass rework without a required fix |
| 2. Every SRS feature gets a page | catalogue (/category/hand-tools, /rentals), account (/auth/login, /auth/register, /auth/forgot-password), contact (/contact) by a path segment; the cart probe `revealed` /checkout by the item hop | met | MET | `discovery.json` `candidates`; `stateProbes[0]` outcome `revealed` |
| 3. Emitted-spec check ran; every shipped test it ran passed | ran; all 16 shipped tests passed | missed | MET by the wording | `emittedRun`: no `inconclusive`, no `notRun`; 20 entries: 16 shipped tests `passed` (the price sort on its second attempt), `authenticate`, the happy login and the wrong-password test `failed` twice, the a11y spec `failed` twice. The two scenario tests were dropped into `emitted_failed` because the run itself had locked the account (D1); the README names the a11y spec |
| 4. Zero shipped tests whose name claims more than the recording proves | 3 | 6 | MISSED | test by test below |
| 5. The happy login survives replay | `passed: true`, no `refused` | met | MET | replay: "logged in with valid credentials" passed |
| 6. The test account still signs in after the run | no: locked | met | MISSED | the owner's preflight after the run, before the re-seed: `LOGIN FAILED ... page says: Account locked, too many failed attempts. Please contact the administrator.`; no `lockoutWarning` on the report because the post-run check never ran (D1) |
| 7. Every product finding is real | no findings | one agent mistake | MET | `findings` is `[]` |
| 8. Zero rules the report counts as covered that no shipped test exercises | 0 not; 4 partly | 2 not | MET | `ruleCoverage.covered` R3, R4, R5, R7, R8, R9, R11, R12, R13, R14, each read by hand below |

Line 3, the honest measure (passed over every `emittedRun.tests` entry): 16 of 20.

Line 4, test by test (16 shipped):

| Shipped test (rule) | What the name claims | What the recording proves | Grade |
| --- | --- | --- | --- |
| displayed hand tools with names, images, and prices | cards show a name, an image and a price | at least 1 card; the first card's text matches a price pattern; the first card's image has a non-empty src; no name is read | OVERCLAIM (names) |
| sorted products by price low to high and verified ascending order (R4) | the list is in ascending price order | after the sort, the second card's price is greater than the first's | borderline as in runs 8 and 9 (two cards for a list claim); not counted |
| filtered by Hammer subcategory and only hammer products remained (R3) | every remaining product is a hammer | the Hammer checkbox is checked, then one read of every card: at least 1 and every one matches `/Hammer/i` | within the claim |
| clicked a product and landed on its detail page with matching name and price (R5) | the detail page shows the listing's name and price | the detail heading equals the captured listing name; the detail unit price matches `^\d+\.\d{2}$`; the rentals listing shows no price, so no price is matched | OVERCLAIM (price) |
| added item to cart, opened cart, changed quantity and the line total updated (R7, R8) | the line total changes with the quantity | the line price after quantity 3 is greater than before | within the claim |
| added item to cart, opened cart, removed the product and the row disappeared from the cart table (R9) | the row is gone | `tbody tr` count 0 after the remove click | within the claim (the name no longer claims the total, as run 9's did) |
| submitted contact form with valid message and email | the submit succeeds | `.alert-success` visible and the first-name input hidden | within the claim |
| rejected submission when message field is empty (R13) | the submit is rejected with a message error | the message alert is visible and contains `/[Mm]essage/`; every other field valid | within the claim |
| rejected an email address without an @ sign (R14) | the submit is rejected because of the email | the email alert is visible and contains `/[Ee]mail/`; the message typed is long enough (only one alert resolved) | within the claim (run 9's D4 case is fixed) |
| filled all required fields and registered successfully | registration succeeds | the URL moves to /auth/login (doctrine rule 9) | within the claim |
| rejected registration with an already-used email address (R11) | the duplicate is rejected | the register error is visible, matches an "already/exists/taken" pattern, and the URL stays | within the claim |
| rejected registration with an empty required field (R12) | a required-field error shows | the first-name error is visible and the URL stays; every other field valid, the email generated | within the claim |
| rejected email field left empty (login) | the empty email is rejected | `aria-invalid="true"` on the email, the email error visible, the URL stays | within the claim |
| rejected password field left empty (login) | the same for the password | the password error visible, the URL stays | within the claim |
| rejected an empty email field (forgot password) | the empty email is rejected | `aria-invalid="true"`, the email error visible, the URL stays | within the claim |
| rejected a malformed email format (forgot password) | the malformed email is rejected | `aria-invalid="true"` on the email after typing it, and the URL stays; no error message is read, and typing an invalid value sets the marker before any submit, while the URL stays whether or not the form submits | OVERCLAIM |

Line 8, by hand (the 10 rules the report counts as covered): R3 fully (the Hammer filter); R4 partly (two cards for a list order, as in line 4); R5 partly (the name matches, the price is never compared); R7 partly (the quantity test reads the line total, not that each added product is listed with its quantity); R8 fully; R9 partly (the row goes, the total is never read); R11 fully; R12 fully (registration's first-name error; the two login-form tests no longer cite it, PR #65); R13 fully; R14 fully. None reads "not".

## 2. Defects

### D1. The wrong-password counter keys on the scenario's name, so it read 0 and the run locked the test account (line 6, two tests lost)

`wrongPasswordSubmits` (`src/agent/test-credentials.ts` line 202) returns 0 unless `isLoginFlow(s)` holds, and `isLoginFlow` (line 143) holds only when the name matches `LOGIN_NAME_RE` (log in, logged in, sign in) or the feature tag is exactly `login`. Run 10's scenario was named "rejected a wrong password" under the feature `account` (the Toolshop map's feature name), so the counter returned 0 for every execution, though the trace fills the account's email by marker and types a literal wrong password: on run 10's own dropped trace, `wrongPasswordSubmits` returns 0, and 1 for the same steps renamed "rejected login with a wrong password" (checked at $0 with `npx tsx`). Run 9's name contained "login", which is why run 9 counted correctly. Every guard downstream reads that number, so all of them were off:

- the ledger printed `wrong-password attempts against the test account: 0 of cap 3` after every stage and `wrongPasswordAttempts.count` is 0;
- stability re-ran the scenario 3 times (invariant 79 skips a scenario whose count is above 0; `stability.credentialSafetySkipped` is absent);
- the emitted-spec check ran it twice;
- `postRunLockoutCheck` runs only when a submit was counted, so the lock went unreported (no `lockoutWarning`).

Submits against the account: explorer 1, replay 1, stability 3, emitted check 2, total 7 against a cap of 3; Toolshop locks after 3. The emitted check then saw "Account locked, too many failed attempts", and `authenticate`, the happy login and the wrong-password test failed twice; the two scenario tests were dropped from the framework. A zero returned for "not a login flow" reads as "no wrong-password submits", standing rule 2. Fix (pre-launch, the one exception to part f): count by the steps, not the name (a scenario that fills the account's identifier by marker and types an unmarked, non-empty password, unless its name is a creation or reset flow, where the identifier is typed into another form), run the post-run sign-in check whenever the run had credentials, and lock it with run 10's exact trace.

### D2. The README names a test that is not in the framework

After the emitted check dropped the happy login, the framework was re-scaffolded without it, so the auth setup (`authenticate`) left the framework too: the zip holds no auth setup file, and `playwright.config.ts` has the `chromium` project only. The README's "Emitted-spec check" section still says `"authenticate": failed twice; it stays in the framework and fails against the site as it is today`, and counts it in "16 of 18 test(s) passed". The deliverable states something false. Fix (pre-launch, same PR): build the section from the tests the re-scaffolded framework holds.

### D3. Three test names claim more than their recording proves (line 4)

"with names" with no name read; "matching name and price" on a listing that shows no price; "rejected a malformed email format" proven by a marker typing alone sets. The Critic passed all three on the first review. Post-launch.

### D4. A role-alert lookup resolved to the email input

In the resumed "rejected an unregistered email address", `assert toBeVisible` with role `alert` and intent "error alert for unregistered email" resolved to `input[type="email"]` (the next call's log shows the locator), so a visibility check of an alert passed on the email box. The stated role found nothing, the call had no testid, css, xpath or text hint, so the intent-derived tiers ran and the smart css built from the word "email" won (invariant 60 keeps a message intent from deriving the submit-button css, not an input css). The Critic rejected the scenario for exactly this, so nothing shipped on it. Post-launch: a message intent derives no form-control css.

### D5. The resume hint drops the ceiling and the stage flags

The hint printed at every stop is `npm run explore -- --resume <path>`, but a checkpoint does not restore `--ceiling`, `--replay`, `--stability`, `--stabilize` or `--stabilize-attempts`. Run as printed, run 10's resume would have run under the $2.00 default ceiling with $3.78 spent and no replay or stability. Fix (pre-launch, same PR, because the printed command is wrong): the hint carries the run's own flags.

### D6. The first-pass rework rate rose to 35.0 percent

Of the 7 reworks, two asked for a narrower selector than an OR css (`.alert-success, [role='alert']`, `.fa-xmark, ...`), two for a cleaner recording of a step that worked (the Hammer filter's first click, the capture element of the quantity test), one for static personal fields beside an email the tool already generates (registration), and two were real (the cart badge read by element count; the rentals click on a hard-coded name). The repair pass kept 6 of 7. Recorded, not fixed.

## 3. Measured, not graded (part e)

- Explorer cost per recorded scenario on the main pass: ($5.6766 minus $1.3129) over 20 = $0.2182 (run 9 $0.2246).
- Context per Explorer call, resume process only (a resumed report lists only the resuming process's calls): 101 calls, mean 25,526, first 15,565, last 35,400. The prompt cache check holds on every call after the second; cached input share 98.1 percent.
- Never explored: 0. Orientation calls: 0.
- Findings: none. In the first process the unregistered-email reset was a locator finding; the resume re-explored it and the Critic rejected it (D4).
- RULE 10 refusals: 1 (a class `/\S/` on the rentals unit price); no shipped test asserts a class pattern.
- No happy forgot-password scenario was planned; three reset negatives were (unregistered, empty, malformed); the empty and malformed ones shipped.
- `Dropped rule citation` lines: 9; two are the new page check (R12 from both login-form tests), one the new home-page check (R1 from the hand-tools display), six the category check.
- Messages ending "(shown, then hidden)": none.
- First-pass reworks with no required fix: none.
- Steps with `absentAsZero`: 0; R6 not covered (its only test, the cart badge, dropped at the repair review with a required fix not applied).
- Projects in the zip's config: `chromium` only (no happy login shipped, so no `signed-in` project).
- The price sort failed the emitted check's first run and passed the retry.
- The README's "Emitted-spec check" section, verbatim: "Before this framework was written, QA-Core ran it once against http://localhost:4200/ (chromium, one worker): 16 of 18 test(s) passed. Tests that did not pass: "authenticate": failed twice; it stays in the framework and fails against the site as it is today. ... "a11y: landing page has no critical/serious WCAG 2 AA violations": failed twice; it stays in the framework and fails against the site as it is today." (D2 for the first entry.)

## 4. Run 10 against run 9

| | Run 9 | Run 10 |
| --- | --- | --- |
| Planned / explored / shipped | 20 / 18 / 18 | 20 / 20 / 16 |
| First-pass rework rate | 22.2 percent | 35.0 percent |
| Overclaiming names (line 4) | 6 | 3 |
| Rules: report / fully / partly / not | 12 / 5 / 5 / 2 | 10 / 6 / 4 / 0 |
| Product findings / agent mistakes | 1 / 1 | 0 / 0 |
| Wrong-password submits counted / real | 3 / 3 | 0 / 7 |
| Account after the run | signs in | locked |
| Cost | $4.73 | $5.87 (two processes) |

## 5. Hand checks by the owner

- After the run, before the re-seed: `npx tsx scripts/preflight-site.ts http://localhost:4200/ --login` printed `LOGIN FAILED (no positive signal within 15 s; still at http://localhost:4200/auth/login)` and `page says: Account locked, too many failed attempts. Please contact the administrator.`
- The re-seed (`php artisan migrate:fresh --seed`) completed.

## 6. Next

Run 10 is the last engine run before launch; its grade stands as recorded. One $0 PR fixes D1, D2 and D5 before launch, because an agent that locks a client's test account and a README that states something false are not launch defects to carry; it is proven offline with run 10's own trace and no live run. D3, D4 and D6 go to the post-launch backlog.
