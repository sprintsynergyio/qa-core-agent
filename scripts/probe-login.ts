/**
 * Run discovery and the login probe alone against a site, $0:
 *
 *   npx tsx scripts/probe-login.ts <url> [--map <requirements-map.json>] [--features a,b] [--login-url <page>]
 *
 * Runs discoverPages (the ladder the runtime runs) and then runStateProbes
 * with the login action (invariant 88), exactly as a run would before it
 * plans, and prints every line a run would print for them: the state probe
 * lines, the rule split lines and the "Login probe:" line. Use it to see
 * which pages behind the sign-in a run would find on a site before paying
 * for one.
 *
 * No model call: the requirements map is read from a requirements-map.json
 * file (an SRS document would need the Haiku map build and is refused), and
 * ANTHROPIC_API_KEY is removed from this process before anything runs.
 * Nothing is written: no run folder, no discovery.json, no session file.
 *
 * It signs in ONCE with the test account from the environment or .env
 * (QA_CORE_TEST_USER_<HOST> / QA_CORE_TEST_PASS_<HOST>, else the generic
 * pair, invariant 70), with the correct password, so it adds nothing toward
 * a lockout. It never prints a credential value, only the variable names.
 * With no account it still runs, and prints which features would be
 * recorded as not looked for.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { discoverPages, fetchRobots } from '../src/agent/discovery.js';
import { featureTokenMap, type RequirementsMap } from '../src/agent/requirements.js';
import { parseCommaSeparated } from '../src/agent/parse-features.js';
import { runStateProbes } from '../src/agent/state-probe.js';
import { CREDENTIALS_NOT_PROVIDED, resolveTestCredentials } from '../src/agent/test-credentials.js';

const USAGE = 'usage: npx tsx scripts/probe-login.ts <url> [--map <requirements-map.json>] [--features a,b] [--login-url <page>]';

function refuse(message: string): never {
  console.error(message);
  console.error(USAGE);
  process.exit(2);
}

const args = process.argv.slice(2);
let url: string | undefined;
let mapPath: string | undefined;
let featuresArg: string | undefined;
let loginUrl: string | undefined;
for (let i = 0; i < args.length; i++) {
  const a = args[i]!;
  if (a === '--map' || a === '--features' || a === '--login-url') {
    const v = args[i + 1];
    if (!v || v.startsWith('--')) refuse(`${a} expects a value.`);
    if (a === '--map') mapPath = v; else if (a === '--features') featuresArg = v; else loginUrl = v;
    i++;
  } else if (a.startsWith('--')) {
    refuse(`unknown option ${a}.`);
  } else if (!url) {
    url = a;
  } else {
    refuse(`unexpected argument ${a}.`);
  }
}
if (!url) refuse('a URL is required.');
let entry: URL;
try {
  entry = new URL(url);
  if (entry.protocol !== 'http:' && entry.protocol !== 'https:') throw new Error('not http or https');
} catch {
  refuse(`"${url}" is not an http or https URL.`);
}

// The map must already exist as JSON: building one from an SRS is a model call.
let map: RequirementsMap | undefined;
if (mapPath) {
  if (!mapPath.toLowerCase().endsWith('.json')) {
    refuse(`--map takes a requirements-map.json; ${path.basename(mapPath)} would need a model call to build a map, which this script never makes.`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
  } catch (err) {
    refuse(`--map ${mapPath} could not be read as JSON (${(err as Error).message}).`);
  }
  const candidate = raw as Partial<RequirementsMap>;
  if (!candidate || !Array.isArray(candidate.features)) refuse(`--map ${mapPath} has no features array; it is not a requirements-map.json.`);
  map = { features: candidate.features, roles: Array.isArray(candidate.roles) ? candidate.roles : [], truncated: candidate.truncated === true };
}
const features = featuresArg ? parseCommaSeparated(featuresArg) : [];

// The account is read before the key is removed; no client in this process can reach a model.
const resolution = resolveTestCredentials(process.env, entry.toString());
delete process.env.ANTHROPIC_API_KEY;

console.log(`probe-login: ${entry.toString()}`);
console.log(resolution.line);

const disc = await discoverPages({ entryUrl: entry.toString(), ...(map ? { requirements: map } : {}), ...(features.length > 0 ? { features } : {}) });
const pathOf = (u: string): string => { try { return new URL(u).pathname; } catch { return u; } };
console.log(`discovery: ${disc.pages.length} candidate(s) via ${disc.method}: ${disc.pages.map((p) => pathOf(p.url)).join(', ')}`);

const tokens = map ? featureTokenMap(map) : undefined;
const probes = await runStateProbes({
  map,
  candidates: disc.pages,
  ...(disc.pageControls ? { pageControls: disc.pageControls } : {}),
  robots: disc.robots ?? await fetchRobots(entry),
  ...(tokens ? { featureTokens: tokens } : {}),
  login: resolution.creds
    ? { access: { url: entry.toString(), ...(loginUrl ? { loginUrl } : {}), user: resolution.creds.user, pass: resolution.creds.pass }, ...(features.length > 0 ? { names: features } : {}) }
    : { unavailable: CREDENTIALS_NOT_PROVIDED },
});
if (probes.lines.length === 0) console.log('no probe line: no feature needed a probe and nothing was looked for.');
for (const line of probes.lines) console.log(line);
console.log(`pages a run would plan behind an action or the sign-in: ${probes.revealed.length}`);
for (const r of probes.revealed) {
  console.log(`  ${pathOf(r.page.url)}  (${r.feature}; start on ${pathOf(r.page.reachedBy.origin)}; rules ${[...r.originRuleIds, ...r.revealedRuleIds].join(', ') || 'none'}; ${r.snapshot.headings.length} heading(s), ${r.snapshot.inputs.length} input(s), ${r.snapshot.buttons.length} button(s) in its snapshot)`);
}
