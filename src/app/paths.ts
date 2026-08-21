/**
 * Path resolution utilities
 *
 * Resolves paths relative to project root, regardless of process.cwd().
 * This allows CLI to run from any directory.
 */

import { fileURLToPath } from 'url';
import { dirname, join, isAbsolute } from 'path';

// Detect project root based on runtime location:
// - tsx runs from src/app/paths.ts (2 levels up)
// - node runs from dist/src/app/paths.js (3 levels up)
// Match /dist/ and \dist\ — Windows path.sep is \, so a /dist/-only check fails there.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const isCompiledDist = /(?:^|[\\/])dist[\\/]/.test(__dirname);
export const PROJECT_ROOT = isCompiledDist
    ? join(__dirname, '..', '..', '..')
    : join(__dirname, '..', '..');

/**
 * Resolve a path relative to project root (unless already absolute)
 */
export function resolveProjectPath(path: string): string {
  if (isAbsolute(path)) return path;
  if (path.startsWith('~')) {
    const home = process.env.HOME || process.env.USERPROFILE || '';
    return join(home, path.slice(2)); // slice(2) removes "~/" — join normalizes separators
  }
  return join(PROJECT_ROOT, path);
}
