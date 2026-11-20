/**
 * Zip reading and writing for the smokes and scripts, in process (adm-zip).
 *
 * No smoke and no script starts a system `zip` or `unzip` (invariant 87), so
 * the suite runs the same on a machine that has neither. Every function
 * throws on an archive that cannot be read: a broken zip must fail the check
 * that reads it, never return an empty listing that looks like a real one.
 */
import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';

type ZipSource = string | Buffer;

function open(src: ZipSource): AdmZip {
  if (typeof src === 'string' && !fs.existsSync(src)) throw new Error(`zip not found: ${src}`);
  return new AdmZip(src);
}

/** Every entry name, folders included (they end with "/"), in archive order: what `unzip -Z1` printed. */
export function zipEntryNames(src: ZipSource): string[] {
  return open(src).getEntries().map((e) => e.entryName);
}

/** File entries only (no folder entries). */
export function zipFileNames(src: ZipSource): string[] {
  return open(src).getEntries().filter((e) => !e.isDirectory).map((e) => e.entryName);
}

/** One entry's content as UTF-8 text. Throws when the archive holds no such entry. */
export function zipEntryText(src: ZipSource, name: string): string {
  const entry = open(src).getEntry(name);
  if (!entry) throw new Error(`zip entry not found: ${name}`);
  return entry.getData().toString('utf8');
}

/** Every file entry with its text, read with one open of the archive. */
export function zipTextEntries(src: ZipSource): Array<{ name: string; text: string }> {
  return open(src).getEntries().filter((e) => !e.isDirectory).map((e) => ({ name: e.entryName, text: e.getData().toString('utf8') }));
}

/** The Unix permission bits an entry was stored with (0 when the archive records none). */
export function zipEntryMode(src: ZipSource, name: string): number {
  const entry = open(src).getEntry(name);
  if (!entry) throw new Error(`zip entry not found: ${name}`);
  return (entry.header.attr >>> 16) & 0o777;
}

/** Extract the whole archive under destDir (created when missing), keeping stored permission bits. */
export function extractZip(src: ZipSource, destDir: string): void {
  fs.mkdirSync(destDir, { recursive: true });
  open(src).extractAllTo(destDir, true, true);
}

/**
 * Write a zip of one folder, rooted at rootName, dot folders included. For
 * fixtures only: the product's own zips come from src/agent/zip-framework.ts.
 */
export function writeFolderZip(folder: string, zipPath: string, rootName: string = path.basename(folder)): void {
  const zip = new AdmZip();
  const walk = (dir: string, rel: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(dir, e.name);
      const name = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(abs, name);
      else if (e.isFile()) zip.addFile(name, fs.readFileSync(abs));
    }
  };
  walk(folder, rootName);
  zip.writeZip(zipPath);
}

/** Run a zip read and report whether it worked, for a check that wants the error text. */
export function tryZip<T>(fn: () => T): { ok: true; value: T; error: '' } | { ok: false; value: undefined; error: string } {
  try {
    return { ok: true, value: fn(), error: '' };
  } catch (e) {
    return { ok: false, value: undefined, error: (e as Error).message };
  }
}
