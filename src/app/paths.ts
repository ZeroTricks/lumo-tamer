/**
 * Path resolution utilities
 *
 * Resolves paths relative to project root, regardless of process.cwd().
 * This allows CLI to run from any directory.
 *
 * Home directory resolution order (highest to lowest priority):
 * 1. CLI argument --home
 * 2. LUMO_HOME environment variable
 * 3. Platform default
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

/**
 * Resolve a path, expanding ~ to home directory
 */
function resolvePath(path: string): string {
  if (isAbsolute(path)) return path;
  if (path.startsWith('~')) {
    return path.replace('~', process.env.HOME || '');
  }
  return path;
}

// ============================================
// Home Directory
// ============================================

const APP_NAME = 'lumo-tamer';
const VAULT_FILENAME = 'vault.enc';
const CONFIG_FILENAME = 'config.yaml';

/**
 * Detect if running inside Docker container
 */
function isDocker(): boolean {
  return existsSync('/.dockerenv');
}

/**
 * Get platform-specific default home directory
 *
 * - Docker: /data
 * - Linux: $XDG_DATA_HOME/lumo-tamer or ~/.local/share/lumo-tamer
 * - macOS: ~/Library/Application Support/lumo-tamer
 * - Windows: %APPDATA%/lumo-tamer
 */
export function getDefaultHome(): string {
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

/**
 * Get home directory from LUMO_HOME environment variable
 */
function getHomeFromEnv(): string | null {
  const envValue = process.env.LUMO_HOME;
  if (envValue) {
    return resolvePath(envValue);
  }
  return null;
}

// Cached resolved home directory
let resolvedHome: string | null = null;

/**
 * Initialize the home directory
 * Resolution order: CLI arg > LUMO_HOME env var > platform default
 *
 * @param cliValue Optional value from --home CLI argument
 */
export function initHome(cliValue?: string): void {
  if (cliValue) {
    resolvedHome = resolvePath(cliValue);
  } else {
    const envValue = getHomeFromEnv();
    if (envValue) {
      resolvedHome = envValue;
    } else {
      resolvedHome = getDefaultHome();
    }
  }
}

/**
 * Get the home directory
 * Call initHome() first, otherwise uses platform default
 */
export function getHome(): string {
  if (resolvedHome === null) {
    resolvedHome = getDefaultHome();
  }
  return resolvedHome;
}

/**
 * Reset home directory (for testing)
 */
export function resetHome(): void {
  resolvedHome = null;
}

/**
 * Ensure home directory exists, creating it with secure permissions if needed
 */
export function ensureHome(): void {
  const dir = getHome();
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
 * Get path to the user config file
 */
export function getConfigPath(): string {
  return join(getHome(), CONFIG_FILENAME);
}

/**
 * Get path to the log file
 * @param filename Log filename (e.g., 'lumo-tamer.log')
 */
export function getLogPath(filename: string): string {
  return join(getHome(), filename);
}

/**
 * Get path to the encrypted vault file
 */
export function getVaultPath(): string {
  return join(getHome(), VAULT_FILENAME);
}

/**
 * Get path for IndexedDB SQLite files (the home directory itself)
 */
export function getConversationsDbPath(): string {
  return getHome();
}
