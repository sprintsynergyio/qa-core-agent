/**
 * What happened to each test the emitted-spec check ran, read from the run's
 * own records (invariant 63), so the run page never says a test was dropped
 * when it stayed in the framework.
 *
 * Run ceeaf2's Summary read "16 of 20 passed, 4 failed twice and dropped".
 * Only 2 were dropped (the two login tests, in report.emittedFailed); the
 * a11y check stayed in the framework, and the auth setup's `authenticate`
 * test left with the login tests, because the scaffold writes
 * tests/auth.setup only when a happy login ships.
 *
 * A failed test is:
 * - dropped: its scenario, or its data case, is in report.emittedFailed
 *   (the title is the one the emitter gives that name, testTitleFor);
 * - removed: the auth setup's test when the final report ships no happy
 *   login, the scaffold's own rule (findHappyLoginScenario), read from the
 *   test's recorded file, never its name;
 * - kept: every other failed test, which the stage leaves in the framework
 *   (the a11y check, or any test of an inconclusive check).
 * A skipped test (the wrong-password cap) is skipped.
 */
import type { RunReport } from './trace.js';
import { findHappyLoginScenario } from './auth-emit.js';
import { parseDataTestTitle, testTitleFor } from './emitted-check.js';

export type EmittedOutcome = 'passed' | 'skipped' | 'dropped' | 'kept' | 'removed';

export interface EmittedTestOutcome {
  name: string;
  status: 'passed' | 'failed' | 'skipped';
  outcome: EmittedOutcome;
  error: string | null;
}

const CATEGORIES = ['happy', 'negative', 'edge', 'a11y'] as const;
const AUTH_SETUP_FILE_RE = /(^|\/)auth\.setup\.(ts|js)$/;

export function emittedTestOutcomes(report: Pick<RunReport, 'emittedRun' | 'emittedFailed' | 'scenarios'>): EmittedTestOutcome[] {
  const run = report.emittedRun;
  if (!run) return [];
  const failed = report.emittedFailed ?? [];
  const droppedTitles = new Set<string>();
  const droppedCases = new Set<string>();
  for (const e of failed) {
    if (e.dataCase) { droppedCases.add(e.scenario); continue; }
    for (const category of CATEGORIES) droppedTitles.add(testTitleFor({ name: e.scenario, category }));
  }
  const loginShips = findHappyLoginScenario(report) !== null;
  return run.tests.map((t) => {
    const base = { name: t.name, status: t.status, error: t.error ?? null };
    if (t.status === 'passed') return { ...base, outcome: 'passed' as const };
    if (t.status === 'skipped') return { ...base, outcome: 'skipped' as const };
    if (droppedTitles.has(t.name)) return { ...base, outcome: 'dropped' as const };
    const data = parseDataTestTitle(t.name);
    if (data && droppedCases.has(`${data.feature}: ${data.caseName}`)) return { ...base, outcome: 'dropped' as const };
    if (t.file && AUTH_SETUP_FILE_RE.test(t.file) && !loginShips) return { ...base, outcome: 'removed' as const };
    return { ...base, outcome: 'kept' as const };
  });
}

export interface EmittedOutcomeCounts { passed: number; skipped: number; dropped: number; kept: number; removed: number }

export function countOutcomes(tests: readonly EmittedTestOutcome[]): EmittedOutcomeCounts {
  const c: EmittedOutcomeCounts = { passed: 0, skipped: 0, dropped: 0, kept: 0, removed: 0 };
  for (const t of tests) c[t.outcome] += 1;
  return c;
}
