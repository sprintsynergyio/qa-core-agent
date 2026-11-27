/**
 * The accessibility scan alone, at $0: what a run would record for these
 * pages (invariant 91), with no model call and nothing written.
 *
 *   npx tsx scripts/a11y-scan.ts <url> [more urls on the same site]
 *
 * It loads each page once, signed out, in order, with the crawl's delay
 * between loads, and runs axe with the tags the run uses. It prints the
 * lines a run prints, then each violation per page with its impact, so the
 * lower-impact ones (noted, never findings) can be read too. It submits no
 * form and signs in nowhere.
 */
import { a11yFindingsOf, a11yObserved, a11yPagesFor, accessibilityLines, scanAccessibility } from '../src/agent/a11y-scan.js';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (args.length === 0) {
  console.error('Usage: npx tsx scripts/a11y-scan.ts <url> [more urls on the same site]');
  process.exit(2);
}
for (const a of args) {
  try { new URL(a); } catch { console.error(`Not a URL: ${a}`); process.exit(2); }
}
// No model is called here; removing the key makes that certain.
delete process.env.ANTHROPIC_API_KEY;

const [entryUrl, ...rest] = args as [string, ...string[]];
const target = a11yPagesFor({ entryUrl, pages: rest.map((url) => ({ url })) });
console.log(`Scanning ${target.urls.length} page(s), signed out, no model call:`);
for (const u of target.urls) console.log(`  ${u}`);
const scan = await scanAccessibility(target);

console.log('');
for (const line of accessibilityLines(scan)) console.log(line);

console.log('\nPer page:');
for (const p of scan.pages) {
  if (p.error) { console.log(`  ${p.url}: NOT SCANNED (${p.error})`); continue; }
  console.log(`  ${p.url}: ${p.violations.length} rule(s) violated`);
  for (const v of p.violations) console.log(`    ${v.id} (${v.impact ?? 'no impact given'}), ${v.nodes} element(s); first: ${v.targets[0] ?? 'none recorded'}`);
}

const findings = a11yFindingsOf(scan);
console.log(`\nFindings a run would record: ${findings.length}`);
for (const f of findings) console.log(`  ${f.ruleId}: ${f.help}\n    ${a11yObserved(f)}\n    ${f.helpUrl}`);
