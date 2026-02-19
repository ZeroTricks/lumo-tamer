/**
 * Config file utilities for reading and writing config.yaml
 *
 * Uses the 'yaml' package which preserves comments and formatting when editing.
 * Provides validation for common issues (directory instead of file, invalid YAML).
 */

import { existsSync, statSync, readFileSync, writeFileSync } from 'fs';
import { parseDocument, parse, Document } from 'yaml';
import { resolveProjectPath } from './paths.js';

/**
 * Load config.defaults.yaml (bundled defaults file).
 * Throws with helpful message if missing or corrupted.
 */
export function loadDefaultsYaml(): Record<string, unknown> {
  const path = resolveProjectPath('config.defaults.yaml');
  try {
    return parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch (e) {
    throw new Error(
      `Failed to load config.defaults.yaml: ${e instanceof Error ? e.message : e}\n` +
      'This file should not be edited. Try: git checkout config.defaults.yaml'
    );
  }
}

export interface ConfigFileStatus {
  exists: boolean;
  isDirectory: boolean;
  isEmpty: boolean;
  path: string;
  error: string | null;
}

export function getConfigPath(): string {
  return resolveProjectPath('config.yaml');
}

/**
 * Check config.yaml status without reading content.
 * Returns error message if the file is a directory or other issues.
 */
export function checkConfigFile(): ConfigFileStatus {
  const path = getConfigPath();

  if (!existsSync(path)) {
    return { exists: false, isDirectory: false, isEmpty: false, path, error: null };
  }

  if (statSync(path).isDirectory()) {
    return {
      exists: true,
      isDirectory: true,
      isEmpty: false,
      path,
      error:
        'config.yaml is a directory, not a file.\n' +
        'This usually happens when Docker creates it automatically.\n' +
        'Fix: rm -rf config.yaml && touch config.yaml',
    };
  }

  const raw = readFileSync(path, 'utf8');
  return { exists: true, isDirectory: false, isEmpty: raw.trim() === '', path, error: null };
}

/**
 * Load config.yaml as plain object (for reading only).
 * Returns empty object if file doesn't exist or is empty.
 * Throws on directory or invalid YAML.
 */
export function loadConfigYaml(): Record<string, unknown> {
  const status = checkConfigFile();
  if (status.error) throw new Error(status.error);
  if (!status.exists || status.isEmpty) return {};

  const doc = parseDocument(readFileSync(status.path, 'utf8'));
  if (doc.errors.length > 0) {
    throw new Error(`Invalid YAML in config.yaml: ${doc.errors[0].message}`);
  }
  return (doc.toJS() ?? {}) as Record<string, unknown>;
}

/**
 * Update config.yaml preserving comments and structure.
 * Creates file if it doesn't exist.
 *
 * @param updater Function that modifies the Document in place
 */
export function updateConfigYaml(updater: (doc: Document) => void): void {
  const status = checkConfigFile();
  if (status.error) throw new Error(status.error);

  let doc: Document;
  if (!status.exists || status.isEmpty) {
    doc = new Document({});
  } else {
    doc = parseDocument(readFileSync(status.path, 'utf8'));
    if (doc.errors.length > 0) {
      throw new Error(`Invalid YAML in config.yaml: ${doc.errors[0].message}`);
    }
  }

  updater(doc);
  writeFileSync(status.path, doc.toString());
}

