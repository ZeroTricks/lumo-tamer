/**
 * Path resolution utilities
 *
 * Resolves paths relative to project root, regardless of process.cwd().
 * This allows CLI to run from any directory.
 */

import { fileURLToPath } from 'url';
import { dirname, join, isAbsolute } from 'path';

// Project root = 2 levels up from src/app/paths.ts (or dist/app/paths.js)
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
export const PROJECT_ROOT = join(__dirname, '..', '..');

/**
 * Resolve a path relative to project root (unless already absolute)
 */
export function resolveProjectPath(path: string): string {
  if (isAbsolute(path)) return path;
  if (path.startsWith('~')) {
    return path.replace('~', process.env.HOME || '');
  }
  return join(PROJECT_ROOT, path);
}
