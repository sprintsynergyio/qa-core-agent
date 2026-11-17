# Diagnosis of run b4e41b (self-hosted Toolshop, 2026-11-17)

Run directory: `output/localhost/20261117T120141Z-b4e41b/`, read through the desktop link at $0. Files read: `run-report.json`, `events.jsonl` (896 lines; "events line N" below is the line number in that file), `console.log` (1022 lines; "console line N"), `discovery.json`, `rule-coverage.json`, `requirements-map.json`, `run-meta.json`, and the framework zip (unpacked; every spec, page object, `playwright.config.ts` and `README.md` read). Compared against run 8 (`docs/audit/run-71d739-diagnosis.md`) on the same benchmark. Toolshop source read at the pinned commit ae7caecb (sparse clone of testsmith-io/practice-software-testing): `sprint5/UI/src/app/auth/forgot-password/forgot-password.component.{ts,html}`, `sprint5/UI/src/app/auth/login/login.component.{ts,html}`, `sprint5/UI/src/app/contact/contact.component.ts`, `sprint5/API/app/Http/Controllers/UserController.php`, `sprint5/API/app/Services/UserService.php`. QA-Core source read where a defect needed it: `src/agent/tools.ts`. Nothing was fetched from the running site by the advisor; the owner ran the three hand checks in section 6.

The command is the bar's: `run-meta.json` `flags` reads lang ts, pom true, the bar's SRS path, replay true, stability true with 3 iterations, stabilize true with 3 attempts, emittedCheck true, `env.QA_CORE_COST_CEILING` "6", and no features, urls, discover, resume or loginUrl. `cost.models` reads exactly the bar's models (requirements, featureParser, pageFilter and planner `claude-haiku-4-5`; explorer `claude-opus-4-7`; critic and stabilizer `claude-sonnet-4-6`), so the run counts as run 9 (STATE.md, "Run 9 bar", part b). The map was reused (console line 9, `requirements map: reused (ac278ddf17eb)`; `cost.requirementsUsd` 0). The preflight signed in before any spend (console line 8). Part c: the owner's terminal shows the API at 200, robots.txt without /auth or /checkout, the re-seed, LOGIN OK, the model and cap env checks printing only `QA_CORE_MODEL_TRANSCRIBE` and `QA_CORE_MODEL_ROUTER`, and the map file present; `git log --oneline -1` after the run read `39deac0`, the #62 merge.

## 1. The bar and its grade

The bar, written Nov 17 before the run (STATE.md, "Run 9 bar", part d), graded with the measurement rules stated there.

| Bar line | Run 9 | Run 8 | Grade | Read from |
| --- | --- | --- | --- | --- |
| 1. Rework rate under 35 percent on the first Critic pass | 22.2 percent (4 rework of 18) | 46.7 percent | MET | `review.repair` has 4 entries, each `first: "rework"`; the first `critic_done` event (events line 667) holds 18 verdicts, 4 `rework`, 14 `pass`, 0 `reject`; no first-pass rework without a required fix (no `reworkWithoutFix` on any entry) |
| 2. Every SRS feature gets a page | catalogue (/category/*), account (/auth/login, /auth/register), contact (/contact) by a path segment; the cart probe `revealed` /checkout | met | MET | `discovery.json` `candidates` (14, browser crawl); `stateProbes[0]` feature "cart", `outcome` "revealed", `revealed` /checkout, by the item hop from /category/hand-tools (console line 23) |
| 3. Emitted-spec check ran and green for every shipped test | ran; 17 of 18 shipped tests passed, 1 not run | not run | MISSED | `emittedRun`: no `inconclusive`, no `notRun`; 20 entries: 18 `passed` (17 shipped tests plus `authenticate`), the a11y spec `failed` twice, and "[negative] rejected login with wrong password and stayed on login page" `skipped` with "would exceed the wrong-password cap (3)" (console line 972). `wrongPasswordAttempts`: cap 3, count 3, byStage explorer 1, repair 1, replay 1, refused at stage `emitted` (D2) |
| 4. Zero shipped tests whose name claims more than the recording proves | 6 | 1 | MISSED | graded test by test below |
| 5. The happy login survives replay | `passed: true`, no `refused` | met | MET | `replay.verdicts`: "logged in with valid test account credentials" passed; `replay.refused` 0 |
| 6. The test account still signs in after the run | yes | locked | MET | no `lockoutWarning` on the report; console line 978 `post-run login check: the test account still signs in after 3 wrong-password attempts`; the owner's preflight after the run, before any re-seed: `LOGIN OK (signal: URL changed to /account)` (section 6). `stability.credentialSafetySkipped` 1 |
| 7. Every product finding is real | 1 product finding, an agent mistake | no findings | MISSED | `findings[0]`, kind `product`; D3 and section 6 |
| 8. Shipped and rules covered (reported, not targeted) | 18 shipped; 12 of 14 by the report; by hand 5 fully, 5 partly, 2 not | 10; 10 of 14; 5 fully, 2 partly | REPORTED | `reconciliation.generated` 18; `ruleCoverage.covered` 12 (R1, R3, R4, R6 to R14), `uncovered` R2 (not-planned) and R5 (planned-but-dropped); console line 1005 |

Line 3, the honest measure (passed over every `emittedRun.tests` entry): 18 of 20. The a11y spec failed twice and stays in the framework as the stage's warn-and-keep rule says (console line 976); it ships red (D6).

Line 4, test by test:

| Shipped test (zip file, line; rule) | What the name claims | What the recording proves | Grade |
| --- | --- | --- | --- |
| `[happy] sorted products by price low to high and the list reordered by ascending price` (`tests/catalogue/catalogue.spec.ts` line 20; R1, R4) | the list is in ascending price order | the first card's price after `price,asc` is less than the first card's price before the sort | borderline, as in run 8: a claim over the list checked on one card; not counted |
| `[happy] checked the "Hammer" category filter and only hammer products remained in the list` (same file, line 26; R3) | at least one product remains and every one is a hammer | one read of every product name: at least 1 item and every name matches `/Hammer/i` | within the claim |
| `[happy] added item to cart, opened checkout, changed quantity and line total updated` (`tests/cart/cart.spec.ts` line 21; R7, R8) | the line total changes with the quantity | the line price after quantity 3 is greater than before | within the claim |
| `[edge] added item to cart, opened checkout, removed the product row and total recalculated to zero` (same file, line 31; R9) | the row is gone and the total reads zero | the `product-quantity` inputs count 0 after the remove click; no total is read | OVERCLAIM |
| `[happy] added product to cart from detail page and cart count badge increased` (same file, line 39; R6) | the badge number went up | badge text before (absent reads "0") is less than after | within the claim |
| `[negative] rejected submission when message field is empty` (`tests/contact/contact.spec.ts` line 19; R13) | the submit is rejected | the confirmation stays hidden; the class check on the textarea is vacuous (D1) | within the claim ("rejected" is proven by the hidden confirmation) |
| `[negative] rejected an email address without an @ sign` (same file, line 27; R14) | the submit is rejected because of the email | the confirmation stays hidden, but the message typed is 46 characters and the site requires at least 50 (`contact.component.ts` line 46, `Validators.minLength(50)`), so the form is rejected whatever the email; the class check on the email is vacuous (D1) | OVERCLAIM (D4) |
| `[happy] submitted contact form with valid email and non-empty message` (same file, line 36) | the submit succeeds | the success message is visible and matches a thanks pattern | within the claim |
| `[happy] logged in with valid test account credentials` (`tests/account/account.spec.ts` line 26) | sign-in works | the URL matches /account | within the claim |
| `[negative] rejected login with wrong password and stayed on login page` (same file, line 32; R10) | an error shows and the user stays | the error element is visible, matches an "Invalid ..." pattern, and the URL stays /auth/login | within the claim (not run by the emitted check, D2) |
| `[edge] submitted login form with empty email field and saw required-field error` (same file, line 42; R12) | a required-field error is shown | the email input's class matches `/(ng-invalid\|is-invalid\|error)/`, true from page load (D1); the URL stays /auth/login | OVERCLAIM: "rejected" is proven, "saw an error" is not |
| `[edge] submitted login form with empty password field and saw required-field error` (same file, line 50; R12) | the same | the same, on the password input | OVERCLAIM |
| `[happy] filled all required fields and submitted registration` (same file, line 58) | registration succeeds | the URL moves to /auth/login after a second submit (the first, with postal code 12345, was refused by the site) | within the claim; the recorded failed submit ships in the test |
| `[negative] rejected registration with an empty first name field` (same file, line 70; R12) | the submit is rejected | the URL stays /auth/register (a successful registration moves to /auth/login); the class check is vacuous | within the claim |
| `[edge] rejected registration with an empty email field` (same file, line 80; R12) | the same | the same | within the claim |
| `[negative] submitted forgot-password with an empty email field and saw a required-field error` (same file, line 90) | an error is shown | the class check is vacuous and the URL check cannot fail: a successful reset also stays on /auth/forgot-password (`forgot-password.component.ts` shows an alert, no navigation) | OVERCLAIM: the test cannot fail |
| `[negative] submitted forgot-password with a malformed email and the form rejected it` (same file, line 97) | the form rejects it | the same two checks, neither of which can fail | OVERCLAIM: the test cannot fail |
| `[negative] rejected registration with an already-used email address` (same file, line 105; R11) | the submit is rejected with an error | the URL stays /auth/register and the error matches an "already exists ..." pattern | within the claim |

The count is 6, with the price sort borderline. This reading is stricter than run 8's: run 8's grade did not check whether a class assertion could fail, so the same shape may have shipped in run 8 unflagged. Four of the six come from one assertion shape (D1).

Verdict: bar missed on lines 3, 4 and 7, met on lines 1, 2, 5 and 6, line 8 reported.

## 2. Run 9 against run 8 (same benchmark)

| Measure | Run 9 (b4e41b) | Run 8 (71d739) | Read from |
| --- | --- | --- | --- |
| Pages | 14 candidates via browser crawl; 7 kept by the relevance pick; 2 reached by action (/product/01M7MP2XWJ4A5AWC8SAEJSP4M8, /checkout); 9 planned | 14; 8; 2; 9 | console lines 18 to 24; Planner lines `[1/9]` to `[9/9]` |
| Planned | 20; nothing cut by a cap (`planTrimmed` [], `planSkippedPages` []) | 20 (2 cut, 1 page unplanned) | `reconciliation.planned` |
| Recorded | 18, plus 1 finding and 1 skip | 15 | first `critic_done` (events line 667) |
| First pass: pass / rework / reject | 14 / 4 / 0 | 8 / 7 / 0 | events line 667 |
| Repair pass | 4 of 4 funded (budget $1.85); 4 re-recorded, 4 kept | 6 of 7 funded; 2 kept, 5 dropped | console line 769; events lines 668 to 810 |
| Replay | 18 of 18 | 10 of 10 | `replay.passed` 18, `failed` 0, `refused` 0 |
| Stability | 17 of 17, 0 flakes, 51 iterations; 1 not re-run (credential safety) | 10 of 10, 30 iterations | `stability` block |
| Emitted-spec check | 18 of 20 entries passed; wrong-password test not run; a11y failed twice | not run | `emittedRun` |
| Shipped | 18 | 10 | `reconciliation.generated` |
| Rules covered | 12 of 14 by the report | 10 of 14 | `ruleCoverage` |
| Cost: map / Planner | $0.0000 / $0.0473 | $0.0000 / $0.0474 | `cost.requirementsUsd`, `cost.plannerUsd` |
| Cost: Explorer, main pass | $4.0427 | $5.1195 | `cost.usd` minus `cost.repairUsd`: 4.59241525 minus 0.549673 |
| Cost: repair pass | $0.5497 | $0.9160 | `cost.repairUsd` |
| Cost: Critic, both passes | $0.0939 ($0.0630 and $0.0310) | $0.1150 | `cost.criticUsd`; `usd` on events lines 667 and 801 |
| Cost: Stabilizer | $0 | $0 | `stability.stabilizerCostUsd` |
| Total | $4.7337, under the $6.00 ceiling | $6.1979, $0.20 over | console line 991 |
| Cost per shipped test | $0.263 | $0.620 | total over shipped |
| Explorer cost per recorded scenario, main pass | $0.2246 | $0.3413 | console line 769 |
| Explorer API calls, main pass | 169 (9.4 per recorded scenario) | 161 (10.7) | `usage` events before `critic_started` (events line 666) |
| Context per main-pass call (input + cache read + cache write) | mean 34,071 tokens; first 16,948, last 50,544 | mean 51,028; first 16,467, last 78,895 | `cost.calls` |
| Cache rule (invariant 53) | holds on all 197 calls after the second; 98.2 percent cached input | holds; 98.9 percent | `cost.calls`, `cost.cachedInputShare` |
| Steps (tool calls) | 265 (217 main pass, 48 repair); 21 failed or refused in the main pass | 231 (186, 45); 21 | `tool_call` and `tool_result` events |
| Wall time, pipeline / to the zip | 12 min 8 s / 12 min 24 s | 14 min 58 s / 15 min 13 s | `startedAt` 12:01:45.859Z, `finishedAt` 12:13:53.921Z, `writtenAt` 12:14:09.402Z |
| End | completed | stopped at the Explorer's share | `stopped` absent |
| Reconciliation | 20 = 18 generated + 0 dropped + 1 finding + 1 skipped | 20 = 10 + 5 + 5 incomplete | `reconciliation.balanced` true |
| Wrong-password submits | 3 (explorer 1, repair 1, replay 1); the account still signs in | 5; locked | `wrongPasswordAttempts`; console line 978 |

PR #60's cost work held: the main-pass context grew to 50,544 tokens instead of 78,895, the cost per recorded scenario fell by a third, and no scenario was left unexplored.

## 3. Engine defects, ranked

### D1. A class-pattern assertion that cannot fail is accepted as a user-visible error

Eight shipped negatives assert `toHaveAttribute("class", /(ng-invalid|is-invalid|error)/)` on the field under test (account spec lines 46, 54, 76, 86, 93, 101; contact spec lines 23 and 32). Angular puts `ng-invalid` on any control whose validators fail, from the moment the form is built: an empty required field carries it at page load, and a field filled with a malformed value carries it right after the fill. The visible error is gated on submit (`[ngClass]="{ 'is-invalid': submitted && ... }"`, `login.component.html` line 28; the same in `forgot-password.component.html`), but the pattern's `ng-invalid` branch matches first. So the assertion passes before Submit is clicked and proves nothing about an error being shown. The Critic accepted every one as "a user-visible failure signal per rule 3" (events line 667). Where the scenario's other assertion is falsifiable (the URL stays on /auth/register or /auth/login, the contact confirmation stays hidden), the rejection is still proven and only the "saw an error" half of the name is not; on /auth/forgot-password the other assertion cannot fail either, so two shipped tests cannot fail at all.

Fix direction: a class-attribute assertion counts as a failure signal only when its pattern cannot match the field's state before the action; the gate or the tool reads the attribute before the scenario's last action and refuses a pattern that already matched (doctrine rule 8 at record time), and the Explorer is steered to the visible error element (`[data-test="email-error"]` and `password-error` on the login form, `email-error` on the forgot-password form; the registration form was not read) or to `aria-invalid="true"`, which Toolshop sets only after submit (`login.component.html` line 32, `forgot-password.component.html` line 18). The Critic's rule 3 says a framework state class is not user-visible. Lock: a fixture form whose input has `ng-invalid` at load; the class pattern is refused, the error element is recorded, and the emitted test fails when the error never shows.

### D2. The wrong-password cap is spent before the emitted-spec check

`wrongPasswordAttempts.byStage`: explorer 1, repair 1, replay 1, then the check refused the test (console line 972). With the cap at 3 (PR #59) and stability already skipping the scenario, any wrong-password scenario the Critic sends to repair uses the whole cap before the check runs, so the check can never run it and line 3 cannot be met. The account still signed in (line 6), so the cap did its job; the budget is in the wrong place.

Fix direction, an owner decision: (a) reserve one submit for the emitted check (the repair pass may not take the last one; when it would, the repair is refused for that scenario and the first recording stands or drops); or (b) replay does not re-run a wrong-password scenario the repair pass just recorded, and the check is its second execution; or (c) the check reports the test as "not run: wrong-password cap" and line 3 reads it as not graded. (a) keeps every stage honest at the same cap. Lock: a fixture run with a repaired wrong-password scenario where the check still runs it.

### D3. A happy reset planned with an unregistered email, and a locate failure filed as a product finding

The only finding (`findings[0]`, kind `product`, console line 747): "submitted forgot-password with a generated email and received a confirmation message", expected a confirmation, "No visible error, validation, or status message". Three faults line up:

(a) Planning. The fill generated an email on purpose (events: `{"filled":"email","generated":"email"}`; invariant 70, owner decision F: a reset never mails the test account). Toolshop validates the address exists before it resets anything (`UserController.php` line 229, `'email' => 'exists:users,email'`; the owner's curl returned HTTP 422 "The selected email is invalid."). So a happy reset with a generated email cannot succeed on this site. The Planner planned it as happy.

(b) Evidence. The site did answer: the form shows the API error in a `role="alert"` box (`forgot-password.component.html`), and `fadeOutMessage()` hides it after 3 seconds (`forgot-password.component.ts`, `setTimeout(..., 3000)`). By the time `captureActualState` read the page, the alert was gone, so the finding says no message was shown.

(c) Classification. The capped assertion targeted `[data-test='forgot-password-confirmation']`, an element the Explorer invented and that never exists on this page. In `assertWithRetryCap` (`tools.ts` lines 2989 to 2998), a first "Could not resolve element" error from `recoverOrFinding` (line 1119, a plain `Error` while the recovery count is under `RECOVERY_CAP`) is passed to `outcomeFailure`, so a target that never resolved counts toward the outcome cap and is filed as kind `product`, when invariants 24 and 67 say it is a locator failure.

Fix direction: an assertion whose target never resolved counts toward the recovery cap only and never toward the outcome cap (standing rule 2: a locate failure must not read as product behavior); `captureActualState` also reads the text of any `role="alert"` or `aria-live` region that appeared after the action, even if it is gone (a mutation observer installed before the action); a reset scenario with a generated email is planned as a negative ("an unregistered email is refused") unless the SRS says unknown emails get a confirmation. Locks: a fixture where an invented selector is asserted twice records a locator finding, not a product one; a fixture alert that hides after 3 s is in the finding's messages.

### D4. Model test data breaks a different rule, and a rule is credited for it

The R14 test ("rejected an email address without an @ sign") types a 46-character message (`contact.spec.ts` line 30: "This is a valid non-empty message for testing.") into a form that requires 50 (`contact.component.ts` line 46). The form is refused for two reasons, and the test cannot tell which; R14 is credited. Nothing checks that a negative scenario's other fields are valid.

Fix direction: a negative scenario must show its other fields pass before the bad one is entered: the Explorer submits the valid form once in the same scenario family (the contact happy scenario's values) or, cheaper, the negative reuses the happy scenario's recorded values for every other field (the dataset layer already knows them). Lock: a fixture with a 50-character minimum where the negative is recorded with the happy message.

### D5. A role and label that miss fall to the first button on the page

Events line 123: `click({"intent":"Add to cart","role":"button","label":"Add to cart"})` resolved to `getByRole('button').first()`, the disabled "Previous" button of the Testing Guide panel, and waited 30 s. A `label` hint does not count as a locating hint (invariant 60 counts testid, css, xpath and text), so the nameless stated-role try ran and the ambiguous pick returned `.first()`. An action on the wrong element is worse than no action; here it failed, elsewhere it could succeed on the wrong button.

Fix direction: a stated role whose name missed never falls to a nameless match for an action; `label` counts as a locating hint for that rule. Lock: `smoke-resolver-fallback` with a page of two buttons and a missing label.

### D6. The zip ships a red test and the README does not say so

The a11y spec failed twice (`emittedRun`, axe found critical or serious violations on the landing page) and stays in the framework; the wrong-password test was not run by the check. The README's Verification section says nothing about the emitted-spec check, the red a11y test or the unrun test. A client's first `npx playwright test` shows a failure the report never mentioned. The violations themselves are product behavior and are not in `findings`.

Fix direction: the README states the emitted-check result in one line per test that did not pass ("failed twice", "not run: wrong-password cap"); an a11y spec that fails twice is either shipped skipped with its violations written to the README, or its violations become findings of kind `product`. Lock: `smoke-emitted-check` reads the README.

### D7. Coverage gaps

(a) R2 (search) is not planned: the two search scenarios were planned on /category/hand-tools and /rentals, which have no search box, and were dropped by page fit (console lines 25 and 34); the home page, which has one, planned 0 scenarios after a contradiction drop and a cross-page duplicate (console lines 36 to 38). Nothing retried R2 on the page that carries it.

(b) R5 was planned on /rentals and skipped: the Explorer found no product cards there (events line 572). Whether /rentals is empty after the re-seed or uses other markup is not established; the rule split should not have put a listing-to-detail scenario on it without product evidence.

(c) R5's coverage reads `planned-but-dropped` while its only scenario was skipped, not dropped; the reason should name the skip.

### D8a. Rule coverage credits rules the test does not exercise (still open)

By hand: fully R3, R6, R8, R10, R11; partly R4 (one card), R7 (the row and line total are read, the quantity is not), R9 (row only), R12 (the rejection is proven on the registration form, the message is not; two citers are login-form tests), R13 (rejection proven, message not); not R1 (credited by a category-page sort) and R14 (D4).

## 4. What worked

- Line 1 at 22.2 percent, the first run under the 35 percent bar; no first-pass rework without a required fix; every repair kept.
- The cost fix: main-pass context capped near 50K tokens, $0.2246 per recorded scenario, no scenario unexplored, total $4.73 under the ceiling.
- The account survived: stability skipped the wrong-password scenario (console line 957), the cap stopped the fourth submit, and the post-run sign-in worked.
- The absent-counter read: the badge scenario recorded "0" before the first add and shipped (2 `absentAsZero` steps); R6 covered.
- The "only hammers" claim now has a one-read all-items check on the filter label (invariant 79).
- Signed-out specs: the config has `login` for account specs and `chromium` for everything else, no session project, as every recording ran.
- The state probe's item hop revealed /checkout again; R7 to R9 recorded through clicks only.
- Replay 18 of 18, stability 51 of 51 iterations, the prompt cache rule on all 197 calls, orientation 0.

## 5. Measured, not graded (STATE.md, "Run 9 bar", part e)

| Measure | Value |
| --- | --- |
| Total cost against the ceiling | $4.7337 against $6.00 (console line 991) |
| Cost per stage | map $0; Planner $0.0473; Explorer main $4.0427; repair $0.5497; Critic $0.0939; Stabilizer $0 |
| Explorer cost per recorded scenario | $0.2246 (run 8 $0.3413, run 7 $0.1712) |
| Mean context per main-pass call | 34,071 (first 16,948, last 50,544); run 8 51,028 |
| Cache rule (invariant 53) | holds on all 197 calls; 98.2 percent cached input |
| Never explored | 0 (run 8: 5) |
| Findings by kind | 1 product (an agent mistake, D3), 0 locator |
| Reworks without a required fix | 0 re-asked, 0 kept |
| `absentAsZero` steps | 2; R6 covered |
| Config projects | `setup`, `login` (account specs), `chromium` (all others, signed out) |
| Run 8's D6 cases | quantity 0 not explored: the Planner proposed it and it was dropped as a near-duplicate of the badge scenario before the Explorer started (console line 63); the Hammer filter shipped with at least 1 item |
| `planTrimmed`, `planSkippedPages` | both [] |
| `orientationCalls` | 0 |
| console.log | 1022 lines; its `Cost:` line (991) and `Rule coverage:` line (1005) match the report |
| `toContainText('')` in the zip's specs | 0 |

## 6. Hand checks by the owner (Nov 17, $0, before any re-seed)

1. `git log --oneline -1` printed `39deac0 ... Merge pull request #62`: the run used the bar's code.
2. `npx tsx scripts/preflight-site.ts http://localhost:4200/ --login` printed `LOGIN OK (signal: URL changed to /account)`: line 6.
3. `curl -X POST http://localhost:8091/users/forgot-password` with an unregistered email returned `{"message":"The selected email is invalid.", ...}` and HTTP 422: the site refuses an unknown email, so the finding is not product behavior (line 7, D3).
