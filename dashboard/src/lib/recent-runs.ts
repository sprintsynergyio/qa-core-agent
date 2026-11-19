/**
 * "Recent runs" on the Projects page: which index rows it shows. The rows
 * arrive from /api/runs newest first; this only leaves out pre-v2 summaries
 * (as the Runs page does by default) and keeps the first few. It computes no
 * value. No `@/` imports here so a smoke can load this file directly under
 * tsx.
 */

/** How many rows "Recent runs" shows. */
export const RECENT_RUNS_SHOWN = 5;
/** How many index rows the page asks for, so pre-v2 rows among the newest do not shorten the list. */
export const RECENT_RUNS_FETCH = 30;

/** The newest runs that have a report, in the order the API returned them. */
export function recentRuns<T extends { status: string }>(rows: T[]): T[] {
  return rows.filter((r) => r.status !== 'legacy').slice(0, RECENT_RUNS_SHOWN);
}
