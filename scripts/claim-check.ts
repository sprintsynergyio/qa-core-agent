/**
 * Read only, $0: what the claim check (invariant 89) says about a finished
 * run. For every shipped scenario it prints the claims its name makes that
 * the recording does not back, and for every rule the report counts as
 * covered, the claims of the rule text that no citing recording backs.
 *
 *   npx tsx scripts/claim-check.ts <run dir> [<run dir> ...]
 *
 * No model call, nothing written. Step values are never printed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { claimGaps, claimsIn, gapText, ruleClaimGaps } from '../src/agent/claim-evidence.js';
import { matchPlanned } from '../src/agent/rule-coverage.js';
import type { RunReport } from '../src/agent/trace.js';

delete process.env.ANTHROPIC_API_KEY;

const dirs = process.argv.slice(2);
if (dirs.length === 0) {
  console.error('usage: npx tsx scripts/claim-check.ts <run dir> [<run dir> ...]');
  process.exit(2);
}

for (const dir of dirs) {
  const reportPath = path.join(dir, 'run-report.json');
  if (!fs.existsSync(reportPath)) { console.log(`${dir}: no run-report.json`); continue; }
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as RunReport;
  const scenarios = report.scenarios ?? [];
  const planned = (report.plan ?? []).map((p) => p.name);
  const claimed = matchPlanned(planned, scenarios.map((s) => s.name));
  const canonical = scenarios.map((s) => (planned.length ? claimed.get(s.name) ?? null : s.name));
  console.log(`\n== ${path.basename(dir)}: ${scenarios.length} shipped ==`);
  let nameGaps = 0;
  scenarios.forEach((s, i) => {
    const name = canonical[i] ?? null;
    if (!name) { console.log(`  ? ${JSON.stringify(s.name)}: matched no planned name, not checked`); return; }
    const claims = claimsIn(name);
    const gaps = claimGaps(name, s.steps, 'name');
    if (gaps.length) nameGaps++;
    const mark = gaps.length ? 'GAP ' : claims.length ? 'ok  ' : '-   ';
    console.log(`  ${mark}${JSON.stringify(name)}${claims.length ? ` claims ${claims.map((c) => `${c.kind}/${c.need}`).join(', ')}` : ''}`);
    for (const g of gaps) console.log(`        ${gapText(g)}`);
  });
  console.log(`  names with a gap: ${nameGaps} of ${scenarios.length}`);

  const mapPath = path.join(dir, 'requirements-map.json');
  const covered = report.ruleCoverage?.covered ?? [];
  if (!fs.existsSync(mapPath) || covered.length === 0) continue;
  const map = JSON.parse(fs.readFileSync(mapPath, 'utf8')) as { features: Array<{ rules: Array<{ id: string; text: string }> }> };
  const ruleText = new Map(map.features.flatMap((f) => f.rules.map((r) => [r.id, r.text] as const)));
  let ruleGaps = 0;
  for (const c of covered) {
    const text = ruleText.get(c.ruleId) ?? '';
    const recordings = scenarios.filter((s) => (s.ruleIds ?? []).includes(c.ruleId)).map((s) => s.steps);
    const gaps = ruleClaimGaps(text, recordings);
    if (gaps.length) ruleGaps++;
    console.log(`  ${gaps.length ? 'GAP ' : claimsIn(text).length ? 'ok  ' : '-   '}${c.ruleId} ${text} [${recordings.length} citing]`);
    for (const g of gaps) console.log(`        ${gapText(g)}`);
  }
  console.log(`  covered rules with a gap: ${ruleGaps} of ${covered.length}`);
}
