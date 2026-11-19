/**
 * The run page's stage tabs: the order of the six stages and which one a
 * view opens on (invariant 86). No `@/` imports here so a smoke can load this
 * file directly under tsx.
 */

export type StageTabKey = 'discovery' | 'plan' | 'explore' | 'review' | 'verify' | 'summary';
export const STAGE_ORDER: StageTabKey[] = ['discovery', 'plan', 'explore', 'review', 'verify', 'summary'];

/**
 * The stage a view opens on. A finished run opens on Summary: what shipped,
 * what it cost, the download. A live run follows the pipeline: the stage that
 * is running, else the last one that has started, else Discovery.
 */
export function defaultStage(stages: Record<StageTabKey, { status: string }>, live: boolean): StageTabKey {
  if (!live) return 'summary';
  const running = STAGE_ORDER.find((k) => stages[k].status === 'running');
  if (running) return running;
  const started = STAGE_ORDER.filter((k) => stages[k].status !== 'pending');
  return started.length ? started[started.length - 1]! : 'discovery';
}

/** The stage an arrow key, Home or End moves to from `active`; null for any other key. */
export function stageForKey(active: StageTabKey, key: string): StageTabKey | null {
  const i = STAGE_ORDER.indexOf(active);
  const n = STAGE_ORDER.length;
  const next = key === 'ArrowRight' ? (i + 1) % n : key === 'ArrowLeft' ? (i + n - 1) % n : key === 'Home' ? 0 : key === 'End' ? n - 1 : -1;
  return next < 0 ? null : STAGE_ORDER[next]!;
}
