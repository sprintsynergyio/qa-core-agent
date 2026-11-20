/**
 * The MCP server reports package.json's version (invariant 87).
 *
 * src/mcp/server.ts said 0.4.0 in two places while package.json said 0.3.0.
 * Now both read packageVersion() (src/agent/package-version.ts). This smoke
 * starts the real server as a child process, connects an MCP client over
 * stdio, and compares what the server reports with package.json:
 *
 *   A. packageVersion() equals package.json's version, from any folder below it
 *   B. the failure path is loud: no package.json named qa-core-agent throws,
 *      and one with no version throws (never a made-up version)
 *   C. the running server's serverInfo.version equals package.json's version
 *   D. the server's ready line on stderr carries the same version
 *   E. src/mcp/server.ts holds no version literal
 *
 * No network, no model call, no API key.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { packageVersion, agentPackageJsonPath, AGENT_PACKAGE_NAME } from '../src/agent/package-version.js';

let pass = 0, fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? `\n     ${hint}` : ''}`); }
};

const agentRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(agentRoot, 'package.json'), 'utf8')) as { name: string; version: string };
console.log(`package.json: ${pkg.name} ${pkg.version}`);

/* ─── A. the helper ─── */
check('A1. package.json names the agent and carries a semver version', pkg.name === AGENT_PACKAGE_NAME && /^\d+\.\d+\.\d+/.test(pkg.version), `${pkg.name} ${pkg.version}`);
check('A2. packageVersion() equals package.json\'s version', packageVersion() === pkg.version, packageVersion());
check('A3. it finds the same file from a nested folder (src/mcp)', path.resolve(agentPackageJsonPath(path.join(agentRoot, 'src', 'mcp'))) === path.resolve(agentRoot, 'package.json'));

/* ─── B. the failure path is loud ─── */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-version-'));
const threwWith = (fn: () => unknown): string => { try { fn(); return ''; } catch (e) { return (e as Error).message; } };
const noPkg = threwWith(() => packageVersion(tmp));
check('B1. a folder with no agent package.json above it throws, naming the package', noPkg.includes(`no package.json named "${AGENT_PACKAGE_NAME}"`), noPkg || 'did not throw');
fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'something-else', version: '9.9.9' }));
const otherPkg = threwWith(() => packageVersion(tmp));
check('B2. another package\'s package.json is never read as the agent\'s', otherPkg.includes('no package.json named'), otherPkg || 'did not throw');
fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: AGENT_PACKAGE_NAME }));
const noVersion = threwWith(() => packageVersion(tmp));
check('B3. an agent package.json with no version throws, never a made-up version', noVersion.includes('has no version'), noVersion || 'did not throw');
fs.rmSync(tmp, { recursive: true, force: true });

/* ─── C and D. the running server ─── */
const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-mcp-root-'));
const env: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ANTHROPIC_API_KEY') env[k] = v;
env.QA_CORE_PROJECT_ROOT = projectRoot;
const tsxCli = path.join(agentRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [tsxCli, path.join(agentRoot, 'src', 'mcp', 'server.ts')],
  cwd: projectRoot,
  env,
  stderr: 'pipe',
});
let stderrText = '';
transport.stderr?.on('data', (chunk: Buffer) => { stderrText += chunk.toString('utf8'); });
const client = new Client({ name: 'smoke-mcp-version', version: '0.0.0' });
let reported: { name?: string; version?: string } | undefined;
let toolNames: string[] = [];
let connectError = '';
try {
  await client.connect(transport);
  reported = client.getServerVersion();
  toolNames = (await client.listTools()).tools.map((t) => t.name).sort();
  // The ready line is written after connect() resolves on the server side; give it a moment.
  for (let i = 0; i < 50 && !stderrText.includes('ready'); i++) await new Promise((r) => setTimeout(r, 100));
} catch (e) {
  connectError = (e as Error).message;
} finally {
  await client.close().catch(() => undefined);
}
console.log(`server reported: ${reported?.name} ${reported?.version}`);
check('C1. an MCP client connects to the real server over stdio', connectError === '' && reported !== undefined, connectError || stderrText.slice(-400));
check('C2. serverInfo.version equals package.json\'s version', reported?.version === pkg.version, `${reported?.version} vs ${pkg.version}`);
check('C3. the server is the real one: it lists qa_explore and qa_heal', toolNames.includes('qa_explore') && toolNames.includes('qa_heal'), toolNames.join(', '));
const readyLine = stderrText.split('\n').find((l) => l.includes('QA-Core MCP server v')) ?? '';
check('D1. the ready line on stderr carries the same version', readyLine.includes(`QA-Core MCP server v${pkg.version} ready`), readyLine || stderrText.slice(-300));
fs.rmSync(projectRoot, { recursive: true, force: true });

/* ─── E. no literal left ─── */
const serverSource = fs.readFileSync(path.join(agentRoot, 'src', 'mcp', 'server.ts'), 'utf8');
const literals = serverSource.match(/v?\d+\.\d+\.\d+/g) ?? [];
check('E1. src/mcp/server.ts holds no version literal', literals.length === 0, literals.join(', '));
check('E2. it reads packageVersion() once and uses it for serverInfo and the ready line',
  (serverSource.match(/packageVersion\(\)/g) ?? []).length === 1 && serverSource.includes("{ name: 'qa-core', version: SERVER_VERSION }") && serverSource.includes('v${SERVER_VERSION} ready'));

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log(`OK: the MCP server reports package.json's version (${pkg.version}), read at runtime through one helper.`);
