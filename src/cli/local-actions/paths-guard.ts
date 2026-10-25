/**
 * Path and secret guards for CLI local actions.
 * Writes and reads stay inside cwd; secret files are never sent to Lumo.
 */

import { existsSync, readdirSync, statSync } from 'fs';
import { extname, isAbsolute, join, relative, resolve, sep } from 'path';

export const SKIP_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  '.venv',
  'venv',
  'node_modules',
  '__pycache__',
  'dist',
  'build',
  'coverage',
  '.next',
  '.turbo',
  'target',
  'vendor',
  '.idea',
  '.vscode',
]);

export const SOURCE_EXT = new Set([
  '.html',
  '.css',
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.jsx',
  '.py',
  '.kt',
  '.kts',
  '.java',
  '.go',
  '.rs',
  '.md',
  '.json',
  '.yml',
  '.yaml',
  '.txt',
  '.toml',
  '.xml',
  '.svg',
]);

const SECRET_NAME =
  /(^|[/\\])(\.env([.][\w.-]+)?|.*credentials.*|.*secret.*|\.pem|\.key|id_rsa|id_ed25519|vault\.enc|auth\.json)$/i;

export interface ResolvedPath {
  ok: true;
  absolute: string;
  relative: string;
}

export interface RejectedPath {
  ok: false;
  error: string;
}

export type PathResolution = ResolvedPath | RejectedPath;

export function isSecretPath(filePath: string): boolean {
  const base = filePath.split(/[/\\]/).pop() ?? filePath;
  return SECRET_NAME.test(filePath) || SECRET_NAME.test(base);
}

export function isInsideCwd(absolutePath: string, cwd = process.cwd()): boolean {
  const root = resolve(cwd);
  const rel = relative(root, resolve(absolutePath));
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

export function resolveProjectFile(filePath: string, cwd = process.cwd()): PathResolution {
  const trimmed = filePath.trim();
  if (!trimmed) {
    return { ok: false, error: 'Empty path' };
  }
  if (isSecretPath(trimmed)) {
    return { ok: false, error: `Refusing secret file: ${trimmed}` };
  }
  const absolute = isAbsolute(trimmed) ? resolve(trimmed) : resolve(cwd, trimmed);
  if (!isInsideCwd(absolute, cwd)) {
    return { ok: false, error: `Path is outside the project: ${trimmed}` };
  }
  return {
    ok: true,
    absolute,
    relative: relative(cwd, absolute) || trimmed,
  };
}

export function listSourceFiles(root: string, maxFiles: number): string[] {
  const files: string[] = [];

  const walk = (dir: string): void => {
    if (files.length >= maxFiles) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= maxFiles) return;
      if (entry.name.startsWith('.') && entry.name !== '.gitignore') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (isSecretPath(full) || isSecretPath(entry.name)) continue;
      if (!SOURCE_EXT.has(extname(entry.name).toLowerCase())) continue;
      if (!existsSync(full) || !statSync(full).isFile()) continue;
      files.push(full);
    }
  };

  walk(root);
  return files;
}
