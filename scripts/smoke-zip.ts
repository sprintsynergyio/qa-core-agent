/**
 * Verifies the framework zipper:
 *   - zipFrameworkToFile writes a valid zip that can be listed and extracted
 *   - zipFrameworkToBuffer returns bytes that read as the same archive
 *   - zipFrameworkToDataUrl returns a proper data: URL
 *   - The zip contains the expected files (no nesting weirdness, no symlinks)
 *   - The unzipped contents match the originals byte-for-byte
 *   - Refuses missing / non-directory inputs
 *   - Sanity: produced zip is < 1 MB for a typical generated framework
 *   - The archive is built in process (no `zip` command, so it works on
 *     Windows): the module starts no child process, it still zips with a PATH
 *     that holds no `zip`, entry names use forward slashes, the root folder
 *     can be renamed, the exclude patterns keep their old meaning, a file's
 *     permission bits survive, and a symlink that points back up the tree
 *     does not loop
 *
 *   - No smoke and no script starts a system `zip` or `unzip` (AK). The one
 *     exception is this file's cross-check AJ: when a system `unzip` is on
 *     PATH it opens the archive too, as a reader that is not the library
 *     that wrote it. With none on PATH, AJ says so and is not counted.
 *
 * No network. Builds a fixture framework via scaffold.ts, then zips it.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scaffold } from '../src/agent/scaffold.js';
import AdmZip from 'adm-zip';
import { zipFrameworkToFile, zipFrameworkToBuffer, zipFrameworkToDataUrl, RUN_ARTIFACTS } from '../src/agent/zip-framework.js';
import type { RunReport } from '../src/agent/trace.js';
import { extractZip, tryZip, zipEntryMode, zipEntryNames } from './lib/zip-read.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-zip-'));
const frameworkDir = path.join(tmpRoot, 'saucedemo-framework');
const zipPath = path.join(tmpRoot, 'saucedemo-framework.zip');

const report: RunReport = {
  url: 'https://www.saucedemo.com/',
  language: 'ts',
  scenarios: [{
    name: 'logged in with valid credentials',
    category: 'happy',
    steps: [
      { kind: 'navigate', url: 'https://www.saucedemo.com/' },
      { kind: 'fill', target: { level: 'role', arg: { role: 'textbox', name: 'Username', exact: true }, intent: 'username input' }, value: 'standard_user' },
      { kind: 'click', target: { level: 'role', arg: { role: 'button', name: 'Login', exact: true }, intent: 'login button' } },
      { kind: 'assert', name: 'inventory URL', assertion: { type: 'toHaveURL', pattern: '/inventory' } },
    ],
  }],
  cascadeStats: { role: 2, label: 0, placeholder: 0, text: 0, alt: 0, title: 0, testid: 0, css: 0, xpath: 0 },
  cost: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, usd: 0 },
  steps: 4,
  startedAt: '2026-06-20T12:00:00Z',
  finishedAt: '2026-06-20T12:01:00Z',
};

scaffold({ report, outDir: frameworkDir, siteName: 'www.saucedemo.com', features: ['login'] });

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ' — ' + hint : ''}`); }
};

// 1. zipFrameworkToFile produces a real file with non-zero size.
const fileResult = zipFrameworkToFile(frameworkDir, zipPath);
check('A. file zip path matches request', fileResult.zipPath === zipPath);
check('B. file zip exists on disk', fs.existsSync(zipPath));
check('C. file zip is non-empty', fileResult.sizeBytes > 0);
check('D. file zip size matches stat', fileResult.sizeBytes === fs.statSync(zipPath).size);

// 2. The zip is a real zip (it can be listed).
const listResult = tryZip(() => zipEntryNames(zipPath));
check('E. the file lists as a zip', listResult.ok, listResult.error);
if (listResult.ok) {
  const listing = listResult.value;
  check('F. zip contains package.json', listing.includes('saucedemo-framework/package.json'));
  check('G. zip contains README.md', listing.includes('saucedemo-framework/README.md'));
  check('H. zip contains pages/', listing.some((n) => n.startsWith('saucedemo-framework/pages/')));
  check('I. zip contains tests/', listing.some((n) => n.startsWith('saucedemo-framework/tests/')));
  check('J. every entry sits under the one top-level directory', listing.length > 0 && listing.every((n) => n.startsWith('saucedemo-framework/')), listing.filter((n) => !n.startsWith('saucedemo-framework/')).join(', '));
}

// 3. The zip extracts correctly and matches original byte-for-byte.
const extractDir = path.join(tmpRoot, 'extracted');
fs.mkdirSync(extractDir);
const extractResult = tryZip(() => extractZip(zipPath, extractDir));
check('K. the zip extracts', extractResult.ok, extractResult.error);
const originalPkg = fs.readFileSync(path.join(frameworkDir, 'package.json'), 'utf8');
const extractedPkg = fs.readFileSync(path.join(extractDir, 'saucedemo-framework', 'package.json'), 'utf8');
check('L. extracted package.json matches original byte-for-byte', originalPkg === extractedPkg);

// 4. zipFrameworkToBuffer returns valid zip bytes.
const buf = zipFrameworkToBuffer(frameworkDir);
check('M. buffer is non-empty', buf.length > 0);
// Zip files start with magic bytes "PK\x03\x04" (local file header signature)
check('N. buffer starts with PK zip signature', buf[0] === 0x50 && buf[1] === 0x4B && buf[2] === 0x03 && buf[3] === 0x04);
// Buffer and file zip won't be byte-equal (zip emits slightly different metadata
// to stdout vs to a file), but they should be functionally equivalent — both
// must extract to identical contents.
const bufferZipPath = path.join(tmpRoot, 'from-buffer.zip');
fs.writeFileSync(bufferZipPath, buf);
const bufferExtractDir = path.join(tmpRoot, 'extracted-from-buffer');
fs.mkdirSync(bufferExtractDir);
const bufferExtract = tryZip(() => extractZip(bufferZipPath, bufferExtractDir));
check('O. buffer-zip extracts cleanly', bufferExtract.ok, bufferExtract.error);
const bufferExtractedPkg = fs.readFileSync(path.join(bufferExtractDir, 'saucedemo-framework', 'package.json'), 'utf8');
check('O2. buffer-zip extracted package.json matches original', originalPkg === bufferExtractedPkg);
// Sizes should be within 10% — minor metadata differences only
const sizeDelta = Math.abs(buf.length - fileResult.sizeBytes) / fileResult.sizeBytes;
check('O3. buffer-zip size within 10% of file-zip size', sizeDelta < 0.1, `delta=${(sizeDelta * 100).toFixed(1)}%`);

// 5. zipFrameworkToDataUrl returns a proper data URL.
const dataUrl = zipFrameworkToDataUrl(frameworkDir);
check('P. data URL has correct prefix', dataUrl.startsWith('data:application/zip;base64,'));
const base64Part = dataUrl.slice('data:application/zip;base64,'.length);
check('Q. data URL base64 is decodable', (() => {
  try { return Buffer.from(base64Part, 'base64').length === buf.length; } catch { return false; }
})());

// 6. Refuses bad inputs.
let threw = false;
try { zipFrameworkToFile('/nonexistent/path/that/should/not/exist', zipPath); } catch { threw = true; }
check('R. file zipper refuses missing source', threw);

threw = false;
try { zipFrameworkToBuffer('/nonexistent/path/that/should/not/exist'); } catch { threw = true; }
check('S. buffer zipper refuses missing source', threw);

// Files (not dirs) should also be refused.
const aRegularFile = path.join(tmpRoot, 'just-a-file.txt');
fs.writeFileSync(aRegularFile, 'not a directory');
threw = false;
try { zipFrameworkToBuffer(aRegularFile); } catch { threw = true; }
check('T. buffer zipper refuses regular file as source', threw);

// 7. Sanity — typical framework should be well under 1 MB.
check('U. zip size under 1 MB (sanity)', fileResult.sizeBytes < 1024 * 1024);

// 8. Built in process, so it works where there is no `zip` command (Windows).
const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const moduleSource = fs.readFileSync(path.join(scriptsDir, '..', 'src', 'agent', 'zip-framework.ts'), 'utf8');
check('V. the zip module starts no child process', !/child_process|spawnSync|execSync|execFile/.test(moduleSource));
const savedPath = process.env.PATH;
process.env.PATH = path.join(tmpRoot, 'empty-bin');
let noZipBuf: Buffer | null = null;
try { noZipBuf = zipFrameworkToBuffer(frameworkDir); } catch { noZipBuf = null; }
process.env.PATH = savedPath;
check('W. it zips with a PATH that holds no zip command', noZipBuf !== null && noZipBuf.length > 0);

// A tree that exercises the root name, the excludes, permissions and a symlink loop.
const tree = path.join(tmpRoot, 'run-20260101T000000Z-abc123');
fs.mkdirSync(path.join(tree, 'tests', 'login'), { recursive: true });
fs.mkdirSync(path.join(tree, 'tests', 'playwright', '.auth'), { recursive: true });
fs.mkdirSync(path.join(tree, 'test-results', 'trace'), { recursive: true });
fs.mkdirSync(path.join(tree, 'empty-dir'));
fs.writeFileSync(path.join(tree, 'package.json'), '{}');
fs.writeFileSync(path.join(tree, 'checkpoint.json'), '{}');
fs.writeFileSync(path.join(tree, 'toolshop-srs.md'), 'srs');
fs.writeFileSync(path.join(tree, 'old.zip'), 'zip');
fs.writeFileSync(path.join(tree, 'tests', 'login', 'login.spec.ts'), 'spec');
fs.writeFileSync(path.join(tree, 'tests', 'checkpoint.json'), 'a nested file with a run artifact name stays');
fs.writeFileSync(path.join(tree, 'tests', 'nested.zip'), 'zip');
fs.writeFileSync(path.join(tree, 'tests', 'playwright', '.auth', 'user.json'), '{"cookies":[]}');
fs.writeFileSync(path.join(tree, 'test-results', 'trace', 't.zip'), 'trace');
fs.writeFileSync(path.join(tree, 'run.sh'), '#!/bin/sh\n');
fs.chmodSync(path.join(tree, 'run.sh'), 0o755);
fs.symlinkSync(tree, path.join(tree, 'tests', 'loop'), 'dir');
const names = (b: Buffer): string[] => new AdmZip(b).getEntries().map((e) => e.entryName).sort();
const renamed = zipFrameworkToBuffer(tree, 'shop-automation-framework');
const renamedNames = names(renamed);
check('X. entries sit under the requested root folder, never the run id', renamedNames.length > 0 && renamedNames.every((n) => n.startsWith('shop-automation-framework/')), renamedNames.join(', '));
check('Y. entry names use forward slashes only', renamedNames.every((n) => !n.includes('\\')));
const has = (n: string): boolean => renamedNames.includes(`shop-automation-framework/${n}`);
check('Z. run artifacts are left out by name at the root, a zip or an SRS copy at any depth, and a nested file with an artifact name stays',
  has('package.json') && has('tests/login/login.spec.ts') && has('tests/checkpoint.json') && !has('checkpoint.json') && !has('toolshop-srs.md') && !has('old.zip') && !has('tests/nested.zip'), renamedNames.join(', '));
check('AA. run output folders are left out at any depth, folder entry included', !renamedNames.some((n) => n.includes('playwright/.auth') || n.includes('test-results')), renamedNames.join(', '));
check('AB. an empty folder keeps its entry', has('empty-dir/'));
const loopEntries = renamedNames.filter((n) => n.includes('/tests/loop/'));
check('AC. a symlink that points back up the tree is not followed into a loop', loopEntries.length === 0 && renamedNames.length < 20, `${renamedNames.length} entries`);
const noExclude = names(zipFrameworkToBuffer(tree, 'shop-automation-framework', []));
check('AD. with an empty exclude list the artifacts are zipped and the run output folders still are not', noExclude.includes('shop-automation-framework/checkpoint.json') && noExclude.includes('shop-automation-framework/old.zip') && !noExclude.some((n) => n.includes('playwright/.auth') || n.includes('test-results')), noExclude.join(', '));
check('AE. the default exclude list is RUN_ARTIFACTS', JSON.stringify(names(zipFrameworkToBuffer(tree, 'shop-automation-framework', RUN_ARTIFACTS))) === JSON.stringify(renamedNames));
// The renamed archive extracts, and the executable bit is stored on the entry.
const renamedZip = path.join(tmpRoot, 'renamed.zip');
fs.writeFileSync(renamedZip, renamed);
const renamedOut = path.join(tmpRoot, 'renamed-out');
const renamedExtract = tryZip(() => extractZip(renamedZip, renamedOut));
check('AF. the renamed archive extracts', renamedExtract.ok && fs.existsSync(path.join(renamedOut, 'shop-automation-framework', 'run.sh')), renamedExtract.error);
const storedMode = zipEntryMode(renamed, 'shop-automation-framework/run.sh');
check('AG. a file keeps its permission bits (stored on the entry)', (storedMode & 0o111) !== 0, storedMode.toString(8));
threw = false;
try { zipFrameworkToBuffer(tree, '../escape'); } catch { threw = true; }
check('AH. a root name that is not a plain folder name is refused', threw);
// Writing the zip inside the folder it zips never puts the zip in itself.
const inside = zipFrameworkToFile(tree, path.join(tree, 'shop-automation-framework.zip'), 'shop-automation-framework');
const insideNames = names(fs.readFileSync(inside.zipPath));
check('AI. a zip written inside its own source folder does not contain itself', !insideNames.some((n) => n.endsWith('.zip')) && insideNames.includes('shop-automation-framework/package.json'), insideNames.join(', '));

// 9. Cross-check with a reader that is not the library that wrote the zip.
// Optional by design: the suite must pass on a machine with no `unzip`, so
// with none on PATH this prints a note and counts nothing.
const probe = spawnSync('unzip', ['-v'], { encoding: 'utf8' });
if (probe.error || probe.status !== 0) {
  console.log('note  AJ did not run: no system unzip on PATH, so no reader other than adm-zip opened the archive in this run');
} else {
  const sysOut = path.join(tmpRoot, 'system-unzip-out');
  const sys = spawnSync('unzip', ['-q', renamedZip, '-d', sysOut], { encoding: 'utf8' });
  const sysRun = path.join(sysOut, 'shop-automation-framework', 'run.sh');
  check('AJ. the system unzip opens the same archive, byte for byte, executable bit kept',
    sys.status === 0 && fs.existsSync(sysRun) && fs.readFileSync(sysRun).equals(fs.readFileSync(path.join(tree, 'run.sh'))) && (process.platform === 'win32' || (fs.statSync(sysRun).mode & 0o111) !== 0), `${sys.status} ${sys.stderr}`);
}

// 10. No smoke and no script starts a system zip or unzip (this file's AJ aside).
const startsZipTool = /\b(?:spawnSync|spawn|execFileSync|execFile|execSync|exec)\(\s*['"`](?:un)?zip\b/;
const offenders: string[] = [];
const scanForZipTool = (dir: string): void => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') scanForZipTool(abs); continue; }
    if (!/\.(ts|mts|js|mjs|cjs)$/.test(e.name)) continue;
    if (path.resolve(abs) === path.resolve(fileURLToPath(import.meta.url))) continue;
    if (startsZipTool.test(fs.readFileSync(abs, 'utf8'))) offenders.push(path.relative(path.join(scriptsDir, '..'), abs));
  }
};
scanForZipTool(scriptsDir);
scanForZipTool(path.join(scriptsDir, '..', 'src'));
check('AK. no file under scripts/ or src/ starts a system zip or unzip', offenders.length === 0, offenders.join(', '));
const ownSource = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
check('AK2. in this file only the optional cross-check AJ does (two unzip calls, no zip call)', (ownSource.match(/spawnSync\('unzip'/g) ?? []).length === 2 && !/spawnSync\('zip'/.test(ownSource));

// Cleanup.
fs.rmSync(tmpRoot, { recursive: true, force: true });

console.log(`\n${pass}/${pass + fail} checks passed.`);
console.log(`Generated framework zip: ${fileResult.sizeBytes} bytes`);
if (fail > 0) process.exit(1);
console.log('OK: zip-framework produces valid, extractable archives.');
