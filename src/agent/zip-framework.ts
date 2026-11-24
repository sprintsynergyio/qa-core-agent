import AdmZip from 'adm-zip';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Framework zipper.
 *
 * Turns a scaffolded framework directory into either:
 *   - A `.zip` file on disk (used by the CLI path so the user can move the
 *     bundle around the filesystem), OR
 *   - A `Buffer` of zip bytes in memory (used by the WebSocket gateway path
 *     so the bytes can be base64-encoded and streamed to the UI for download).
 *
 * The archive is built in process with adm-zip. It used to shell out to the
 * platform `zip` command, which Windows does not have. Entry names always use
 * forward slashes, whatever the host's path separator, so a zip written on
 * Windows opens the same way everywhere. Each entry keeps its file's
 * modification time and permission bits and nothing else about the machine.
 */

const MAX_ZIP_BYTES = 100 * 1024 * 1024; // 100 MB — pathological cap, real frameworks are <1 MB

/**
 * Run-folder artifacts that never belong in a framework zip, excluded by
 * name at zip time whenever the zipped directory is a run
 * directory. The redacted run-report the scaffold writes under the framework
 * root is a different file and stays.
 */
export const RUN_ARTIFACTS: readonly string[] = ['checkpoint.json', 'events.jsonl', 'run-meta.json', 'requirements-map.json', 'rule-coverage.json', 'console.log', '*.zip', '*-srs.md', '*-srs.txt', '*-srs.pdf', '*-srs.docx'];

/**
 * Folders a Playwright run leaves inside a framework tree, excluded from
 * EVERY zip by path, whatever they hold (invariant 70). playwright/.auth/
 * holds the saved session of the auth setup: a live session cookie for the
 * test account. Run 4b0e43's zip was refused only because saucedemo's
 * session cookie equals the username; on a site whose cookie is a random
 * token the value grep would miss it and the session would ship. The
 * report folders hold traces and screenshots of the run. The emitted-spec
 * check deletes all four after it runs, and the pre-zip guard refuses a
 * tree that still has a session file; this list is the last line.
 */
export const RUN_OUTPUT_DIRS: readonly string[] = ['playwright/.auth', 'test-results', 'playwright-report', 'blob-report'];

/** True for a path, relative to the archive root, that sits in or under a run output folder at any depth. */
function inRunOutputDir(rel: string): boolean {
  return RUN_OUTPUT_DIRS.some((d) => rel === d || rel.startsWith(`${d}/`) || rel.endsWith(`/${d}`) || rel.includes(`/${d}/`));
}

/**
 * An exclude pattern as a matcher on a path relative to the archive root.
 * The patterns keep the meaning they had as `zip -x <root>/<pattern>`
 * arguments: `*` matches any run of characters, a slash included, and `?`
 * one character, against the whole path. So `checkpoint.json` leaves out
 * only the file at the root, and `*.zip` leaves out a zip at any depth.
 */
function excludeMatcher(patterns: readonly string[]): (rel: string) => boolean {
  const res = patterns.map((p) => new RegExp('^' + p.split('*').map((part) => part.split('?').map((lit) => lit.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('.')).join('.*') + '$'));
  return (rel) => res.some((re) => re.test(rel));
}

interface ZipEntry { name: string; abs: string; stat: fs.Stats; dir: boolean }

/**
 * Every entry of the archive, sorted, under one root folder. By default the
 * root is the source directory's own name. A run directory is named by its
 * run id, so callers pass `rootName` (the <brand>-automation-framework name)
 * and the entries are written under it. A symlink is followed, as `zip -r`
 * followed it; a directory already being walked is never entered again, so a
 * link that points back up the tree cannot loop.
 */
function collectEntries(srcDir: string, rootName: string | undefined, exclude: readonly string[]): ZipEntry[] {
  const resolved = path.resolve(srcDir);
  const base = rootName ?? path.basename(resolved);
  if (!/^[A-Za-z0-9._-]+$/.test(base) || base === '.' || base === '..') throw new Error(`zip root name must be a plain directory name (got "${base}")`);
  const excluded = excludeMatcher(exclude);
  const entries: ZipEntry[] = [{ name: `${base}/`, abs: resolved, stat: fs.statSync(resolved), dir: true }];
  const walk = (dir: string, rel: string, open: readonly string[]): void => {
    for (const name of fs.readdirSync(dir).sort()) {
      const abs = path.join(dir, name);
      const childRel = rel ? `${rel}/${name}` : name;
      if (excluded(childRel) || inRunOutputDir(childRel)) continue;
      let stat: fs.Stats;
      try { stat = fs.statSync(abs); } catch { continue; } // a dangling symlink: nothing to store
      if (stat.isDirectory()) {
        const real = fs.realpathSync(abs);
        if (open.includes(real)) continue; // a link back to a folder being walked
        entries.push({ name: `${base}/${childRel}/`, abs, stat, dir: true });
        walk(abs, childRel, [...open, real]);
      } else if (stat.isFile()) {
        entries.push({ name: `${base}/${childRel}`, abs, stat, dir: false });
      }
    }
  };
  walk(resolved, '', [fs.realpathSync(resolved)]);
  return entries;
}

/** The archive bytes for a source directory. Throws past MAX_ZIP_BYTES. */
function buildZip(srcDir: string, rootName: string | undefined, exclude: readonly string[]): Buffer {
  const zip = new AdmZip();
  for (const e of collectEntries(srcDir, rootName, exclude)) {
    zip.addFile(e.name, e.dir ? Buffer.alloc(0) : fs.readFileSync(e.abs), '', e.stat);
  }
  const buffer = zip.toBuffer();
  if (buffer.length === 0) throw new Error('zip produced no output');
  if (buffer.length > MAX_ZIP_BYTES) throw new Error(`zip output (${buffer.length} bytes) exceeds MAX_ZIP_BYTES (${MAX_ZIP_BYTES})`);
  return buffer;
}

export interface ZipResult {
  /** Absolute path to the .zip on disk. */
  zipPath: string;
  /** Size of the .zip in bytes. */
  sizeBytes: number;
}

/**
 * Zip a directory to disk. The resulting zip preserves the source directory
 * as its top-level folder (so unzipping it produces `srcDir-basename/...`,
 * not loose files dumped into cwd).
 */
export function zipFrameworkToFile(srcDir: string, destZipPath: string, rootName?: string, exclude: readonly string[] = RUN_ARTIFACTS): ZipResult {
  if (!fs.existsSync(srcDir) || !fs.statSync(srcDir).isDirectory()) {
    throw new Error(`Source is not a directory: ${srcDir}`);
  }
  // Run-folder artifacts by name, and the run output folders always
  // (RUN_OUTPUT_DIRS). The bytes are built before the destination is touched,
  // so a zip written inside the source directory never contains itself.
  const buffer = buildZip(srcDir, rootName, exclude);
  if (fs.existsSync(destZipPath)) fs.unlinkSync(destZipPath);
  fs.writeFileSync(destZipPath, buffer);
  return { zipPath: destZipPath, sizeBytes: fs.statSync(destZipPath).size };
}

/**
 * Zip a directory and return the bytes as a Buffer. Used by the gateway
 * which then base64-encodes and streams over the WebSocket.
 *
 * Throws if the result would exceed `MAX_ZIP_BYTES` — that's a sanity cap
 * against pathological inputs, real generated frameworks are well under 1 MB.
 */
export function zipFrameworkToBuffer(srcDir: string, rootName?: string, exclude: readonly string[] = RUN_ARTIFACTS): Buffer {
  if (!fs.existsSync(srcDir) || !fs.statSync(srcDir).isDirectory()) {
    throw new Error(`Source is not a directory: ${srcDir}`);
  }
  // Run-folder artifacts are excluded by name, never moved aside; the run
  // output folders (RUN_OUTPUT_DIRS) are excluded whatever `exclude` says.
  return buildZip(srcDir, rootName, exclude);
}

/**
 * Convenience: zip a framework, base64-encode it, return the data URL form
 * the UI can drop into an `<a href=...>` to trigger a browser download.
 *
 * Output prefix is `data:application/zip;base64,` followed by the encoded
 * bytes. Total payload is ~33% larger than the raw zip — acceptable for
 * typical framework sizes (50–500 KB).
 */
export function zipFrameworkToDataUrl(srcDir: string): string {
  const buf = zipFrameworkToBuffer(srcDir);
  return 'data:application/zip;base64,' + buf.toString('base64');
}
