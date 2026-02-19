/**
 * Unit tests for config-file utility
 *
 * Tests YAML loading, saving with comment preservation, and error handling.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Document, parseDocument } from 'yaml';

import { checkConfigFileAt } from '../../src/app/config-file.js';

function loadConfigYamlAt(path: string): Record<string, unknown> {
  const status = checkConfigFileAt(path);
  if (status.error) throw new Error(status.error);
  if (!status.exists || status.isEmpty) return {};

  const doc = parseDocument(readFileSync(path, 'utf8'));
  if (doc.errors.length > 0) {
    throw new Error(`Invalid YAML in config.yaml: ${doc.errors[0].message}`);
  }
  return (doc.toJS() ?? {}) as Record<string, unknown>;
}

function updateConfigYamlAt(path: string, updater: (doc: Document) => void): void {
  const status = checkConfigFileAt(path);
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

let tmpDir: string;
let configPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'config-file-test-'));
  configPath = join(tmpDir, 'config.yaml');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('checkConfigFile', () => {
  it('returns exists: false when file does not exist', () => {
    const status = checkConfigFileAt(configPath);
    expect(status.exists).toBe(false);
    expect(status.error).toBeNull();
  });

  it('detects directory and returns error message', () => {
    mkdirSync(configPath);
    const status = checkConfigFileAt(configPath);
    expect(status.exists).toBe(true);
    expect(status.isDirectory).toBe(true);
    expect(status.error).toContain('config.yaml is a directory');
    expect(status.error).toContain('Docker');
    expect(status.error).toContain('rm -rf');
  });

  it('detects empty file', () => {
    writeFileSync(configPath, '');
    const status = checkConfigFileAt(configPath);
    expect(status.exists).toBe(true);
    expect(status.isEmpty).toBe(true);
    expect(status.error).toBeNull();
  });

  it('detects whitespace-only file as empty', () => {
    writeFileSync(configPath, '   \n\t\n  ');
    const status = checkConfigFileAt(configPath);
    expect(status.isEmpty).toBe(true);
  });

  it('detects file with content', () => {
    writeFileSync(configPath, 'key: value');
    const status = checkConfigFileAt(configPath);
    expect(status.exists).toBe(true);
    expect(status.isEmpty).toBe(false);
    expect(status.isDirectory).toBe(false);
    expect(status.error).toBeNull();
  });
});

describe('loadConfigYaml', () => {
  it('returns empty object when file does not exist', () => {
    const config = loadConfigYamlAt(configPath);
    expect(config).toEqual({});
  });

  it('returns empty object for empty file', () => {
    writeFileSync(configPath, '');
    const config = loadConfigYamlAt(configPath);
    expect(config).toEqual({});
  });

  it('parses valid YAML', () => {
    writeFileSync(configPath, 'auth:\n  method: "login"\nserver:\n  apiKey: "test"');
    const config = loadConfigYamlAt(configPath);
    expect(config).toEqual({
      auth: { method: 'login' },
      server: { apiKey: 'test' },
    });
  });

  it('throws on directory', () => {
    mkdirSync(configPath);
    expect(() => loadConfigYamlAt(configPath)).toThrow('config.yaml is a directory');
  });

  it('throws on invalid YAML', () => {
    writeFileSync(configPath, 'invalid: yaml: content: [unclosed');
    expect(() => loadConfigYamlAt(configPath)).toThrow('Invalid YAML');
  });
});

describe('updateConfigYaml', () => {
  it('creates new file when none exists', () => {
    updateConfigYamlAt(configPath, (doc) => {
      doc.set('auth', { method: 'login' });
    });

    expect(existsSync(configPath)).toBe(true);
    const content = readFileSync(configPath, 'utf8');
    expect(content).toContain('auth');
    expect(content).toContain('method');
    expect(content).toContain('login');
  });

  it('creates file from empty file', () => {
    writeFileSync(configPath, '');
    updateConfigYamlAt(configPath, (doc) => {
      doc.set('server', { apiKey: 'test-key' });
    });

    const config = loadConfigYamlAt(configPath);
    expect(config).toEqual({ server: { apiKey: 'test-key' } });
  });

  it('preserves comments when updating', () => {
    const originalContent = `# Top comment
auth:
  method: "browser"  # inline comment
  browser:
    cdpEndpoint: "http://localhost:9222"

# Server section
server:
  apiKey: "old-key"
`;
    writeFileSync(configPath, originalContent);

    updateConfigYamlAt(configPath, (doc) => {
      const auth = doc.get('auth', true) as any;
      auth.set('method', 'login');
    });

    const result = readFileSync(configPath, 'utf8');
    expect(result).toContain('# Top comment');
    expect(result).toContain('# inline comment');
    expect(result).toContain('# Server section');
    expect(result).toContain('login');
    expect(result).not.toContain('"browser"');
  });

  it('throws on directory', () => {
    mkdirSync(configPath);
    expect(() =>
      updateConfigYamlAt(configPath, () => {})
    ).toThrow('config.yaml is a directory');
  });

  it('throws on invalid YAML', () => {
    writeFileSync(configPath, 'invalid: [unclosed');
    expect(() =>
      updateConfigYamlAt(configPath, () => {})
    ).toThrow('Invalid YAML');
  });
});

