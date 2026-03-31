/**
 * Tests for path utilities - data directory resolution
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  getDefaultDataDir,
  getDataDir,
  setDataDir,
  resetDataDir,
  ensureDataDir,
  getVaultPath,
  getConversationsDbPath,
} from '../../src/app/paths.js';

describe('getDefaultDataDir', () => {
  it('returns XDG-compliant path on Linux', () => {
    if (process.platform !== 'linux') return;

    const result = getDefaultDataDir();
    // Should use XDG_DATA_HOME or ~/.local/share
    expect(result).toMatch(/lumo-tamer$/);
    expect(result).toMatch(/\.local\/share\/lumo-tamer$|\/lumo-tamer$/);
  });

  it('respects XDG_DATA_HOME environment variable', () => {
    if (process.platform !== 'linux') return;

    const originalXdg = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = '/custom/data';

    try {
      const result = getDefaultDataDir();
      expect(result).toBe('/custom/data/lumo-tamer');
    } finally {
      if (originalXdg === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = originalXdg;
      }
    }
  });
});

describe('setDataDir and getDataDir', () => {
  beforeEach(() => {
    resetDataDir();
  });

  afterEach(() => {
    resetDataDir();
  });

  it('uses platform default when set to empty string', () => {
    setDataDir('');
    const result = getDataDir();
    expect(result).toBe(getDefaultDataDir());
  });

  it('resolves absolute paths as-is', () => {
    setDataDir('/custom/absolute/path');
    expect(getDataDir()).toBe('/custom/absolute/path');
  });

  it('expands tilde to home directory', () => {
    const home = process.env.HOME || '';
    setDataDir('~/mydata');
    expect(getDataDir()).toBe(join(home, 'mydata'));
  });

  it('caches the resolved value', () => {
    setDataDir('/first/path');
    expect(getDataDir()).toBe('/first/path');

    // Without reset, should still return cached value
    // (setDataDir updates the cache, so this tests getDataDir caching)
    expect(getDataDir()).toBe('/first/path');
  });
});

describe('ensureDataDir', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'paths-test-'));
    resetDataDir();
  });

  afterEach(() => {
    resetDataDir();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates directory if it does not exist', () => {
    const newDir = join(tmpDir, 'new-data-dir');
    setDataDir(newDir);

    expect(existsSync(newDir)).toBe(false);
    ensureDataDir();
    expect(existsSync(newDir)).toBe(true);
  });

  it('creates directory with secure permissions (0o700)', () => {
    const newDir = join(tmpDir, 'secure-dir');
    setDataDir(newDir);
    ensureDataDir();

    const stats = statSync(newDir);
    // Check owner-only permissions (0o700 = rwx------)
    expect(stats.mode & 0o777).toBe(0o700);
  });

  it('does nothing if directory already exists', () => {
    // tmpDir already exists
    setDataDir(tmpDir);
    expect(() => ensureDataDir()).not.toThrow();
  });

  it('creates nested directories recursively', () => {
    const deepDir = join(tmpDir, 'a', 'b', 'c');
    setDataDir(deepDir);
    ensureDataDir();

    expect(existsSync(deepDir)).toBe(true);
  });
});

describe('getVaultPath and getConversationsDbPath', () => {
  beforeEach(() => {
    resetDataDir();
  });

  afterEach(() => {
    resetDataDir();
  });

  it('returns vault.enc in data directory', () => {
    setDataDir('/test/data');
    expect(getVaultPath()).toBe('/test/data/vault.enc');
  });

  it('returns data directory for conversations', () => {
    setDataDir('/test/data');
    expect(getConversationsDbPath()).toBe('/test/data');
  });
});
