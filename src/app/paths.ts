/**
 * Path resolution utilities
 *
 * Resolves paths relative to project root, regardless of process.cwd().
 * This allows CLI to run from any directory.
 */

import { existsSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, isAbsolute } from 'path';

// Detect project root based on runtime location:
// - tsx runs from src/app/paths.ts (2 levels up)
// - node runs from dist/src/app/paths.js (3 levels up)
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const isCompiledDist = __dirname.includes('/dist/');
export const PROJECT_ROOT = isCompiledDist
    ? join(__dirname, '..', '..', '..')
    : join(__dirname, '..', '..');

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

// ============================================
// Data Directory
// ============================================

const APP_NAME = 'lumo-tamer';
const VAULT_FILENAME = 'vault.enc';

/**
 * Detect if running inside Docker container
 */
function isDocker(): boolean {
  return existsSync('/.dockerenv');
}

/**
 * Get platform-specific default data directory
 *
 * - Docker: /data
 * - Linux: $XDG_DATA_HOME/lumo-tamer or ~/.local/share/lumo-tamer
 * - macOS: ~/Library/Application Support/lumo-tamer
 * - Windows: %APPDATA%/lumo-tamer
 */
export function getDefaultDataDir(): string {
  if (isDocker()) {
    return '/data';
  }

  const home = process.env.HOME || '';

  switch (process.platform) {
    case 'darwin':
      return join(home, 'Library', 'Application Support', APP_NAME);
    case 'win32':
      return join(process.env.APPDATA || join(home, 'AppData', 'Roaming'), APP_NAME);
    default:
      // Linux and other Unix-like systems: follow XDG Base Directory Specification
      const xdgDataHome = process.env.XDG_DATA_HOME || join(home, '.local', 'share');
      return join(xdgDataHome, APP_NAME);
  }
}

// Cached resolved data directory
let resolvedDataDir: string | null = null;

/**
 * Get the data directory, resolving from config or using platform default
 * Call setDataDir() first if using config value, otherwise uses platform default
 */
export function getDataDir(): string {
  if (resolvedDataDir === null) {
    resolvedDataDir = getDefaultDataDir();
  }
  return resolvedDataDir;
}

/**
 * Set the data directory from config value
 * Empty string means use platform default
 */
export function setDataDir(configValue: string): void {
  if (configValue === '') {
    resolvedDataDir = getDefaultDataDir();
  } else {
    resolvedDataDir = resolveProjectPath(configValue);
  }
}

/**
 * Reset data directory (for testing)
 */
export function resetDataDir(): void {
  resolvedDataDir = null;
}

/**
 * Ensure data directory exists, creating it with secure permissions if needed
 */
export function ensureDataDir(): void {
  const dir = getDataDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

// TODO: add same checks as before:
// Verify databaseBasePath is a writable directory
// try {
//     const stat = fs.statSync(databaseBasePath);
//     if (!stat.isDirectory()) {
//         throw new Error(`databasePath "${databaseBasePath}" is not a directory`);
//     }
//     fs.accessSync(databaseBasePath, fs.constants.W_OK);
// } catch (err) {
//     if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
//         throw new Error(`databasePath "${databaseBasePath}" does not exist`);
//     }
//     if ((err as NodeJS.ErrnoException).code === 'EACCES') {
//         throw new Error(`databasePath "${databaseBasePath}" is not writable`);
//     }
//     throw err;
// }

/**
 * Get path to the encrypted vault file
 */
export function getVaultPath(): string {
  return join(getDataDir(), VAULT_FILENAME);
}

/**
 * Get path for IndexedDB SQLite files (the data directory itself)
 */
export function getConversationsDbPath(): string {
  return getDataDir();
}
