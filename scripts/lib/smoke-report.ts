/**
 * What the suite runner prints for a smoke that failed.
 *
 * The runner used to print only the last 20 lines of output. A smoke that
 * prints a long table after its checks (smoke-design-system) pushed the one
 * FAIL line out of that tail, so the report named no failing check. Now every
 * FAIL line is printed first, whole and uncapped, then the tail.
 */

export const TAIL_LINES = 20;

/**
 * Every line that reports a failed check: a line starting with FAIL, plus the
 * indented hint lines right under it (some smokes print the hint on its own line).
 */
export function failureLines(lines: string[]): string[] {
  const out: string[] = [];
  let inHint = false;
  for (const line of lines) {
    if (/^\s*FAIL\b/.test(line)) { out.push(line.trim()); inHint = true; continue; }
    if (inHint && /^\s{3,}\S/.test(line)) { out.push(`    ${line.trim()}`); continue; }
    inHint = false;
  }
  return out;
}

/** The lines the runner prints under a failed smoke's name. */
export function failureReport(name: string, reason: string, lines: string[]): string[] {
  const fails = failureLines(lines);
  const tail = lines.slice(-TAIL_LINES);
  const out: string[] = ['', `=== ${name}: ${reason} ===`];
  if (fails.length > 0) {
    out.push(`${fails.filter((l) => !l.startsWith('    ')).length} FAIL line(s):`);
    for (const l of fails) out.push(`  ${l}`);
  } else {
    out.push('no FAIL line in the output (the smoke crashed, timed out or printed no OK line)');
  }
  out.push(`last ${tail.length} line(s) of output:`);
  for (const l of tail) out.push(`  ${l}`);
  return out;
}
