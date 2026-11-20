/**
 * The agent's own version, read from its package.json at runtime.
 *
 * One source for every place that reports a version (the MCP server's
 * serverInfo and its ready line), so a release bump in package.json is the
 * only edit. A package.json that cannot be found or carries no version
 * throws: a made-up version would read as a real one.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const AGENT_PACKAGE_NAME = 'qa-core-agent';

/** The nearest package.json at or above `from` whose name is the agent's. */
export function agentPackageJsonPath(from: string = path.dirname(fileURLToPath(import.meta.url))): string {
  let dir = from;
  for (let i = 0; i < 12; i++) {
    const candidate = path.join(dir, 'package.json');
    if (fs.existsSync(candidate)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(candidate, 'utf8')) as { name?: unknown };
        if (pkg.name === AGENT_PACKAGE_NAME) return candidate;
      } catch {
        // An unreadable package.json on the way up is not the agent's; keep walking.
      }
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error(`package version: no package.json named "${AGENT_PACKAGE_NAME}" at or above ${from}`);
}

/** The version in the agent's package.json. Throws when it is missing or not a string. */
export function packageVersion(from?: string): string {
  const file = agentPackageJsonPath(from);
  const pkg = JSON.parse(fs.readFileSync(file, 'utf8')) as { version?: unknown };
  if (typeof pkg.version !== 'string' || pkg.version.trim() === '') {
    throw new Error(`package version: ${file} has no version`);
  }
  return pkg.version;
}
