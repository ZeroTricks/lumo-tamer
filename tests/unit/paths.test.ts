/**
 * Tests for path utilities - home directory resolution
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  getDefaultHome,
  getHome,
  initHome,
  resetHome,
  ensureHome,
  getVaultPath,
  getConversationsDbPath,
  getConfigPath,
  getLogPath,
} from '../../src/app/paths.js';

describe('getDefaultHome', () => {
  it('returns XDG-compliant path on Linux', () => {
    if (process.platform !== 'linux') return;

    const result = getDefaultHome();
    // Should use XDG_DATA_HOME or ~/.local/share
    expect(result).toMatch(/lumo-tamer$/);
    expect(result).toMatch(/\.local\/share\/lumo-tamer$|\/lumo-tamer$/);
  });

  it('respects XDG_DATA_HOME environment variable', () => {
    if (process.platform !== 'linux') return;

    const originalXdg = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = '/custom/data';

    try {
      const result = getDefaultHome();
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

describe('initHome and getHome', () => {
  const originalLumoHome = process.env.LUMO_HOME;

  beforeEach(() => {
    resetHome();
    delete process.env.LUMO_HOME;
  });

  afterEach(() => {
    resetHome();
    if (originalLumoHome === undefined) {
      delete process.env.LUMO_HOME;
    } else {
      process.env.LUMO_HOME = originalLumoHome;
    }
  });

  it('uses platform default when no CLI arg or env var', () => {
    initHome();
    const result = getHome();
    expect(result).toBe(getDefaultHome());
  });

  it('uses CLI argument when provided', () => {
    initHome('/cli/path');
    expect(getHome()).toBe('/cli/path');
  });

  it('expands tilde in CLI argument', () => {
    const home = process.env.HOME || '';
    initHome('~/mydata');
    expect(getHome()).toBe(join(home, 'mydata'));
  });

  it('uses LUMO_HOME env var when no CLI arg', () => {
    process.env.LUMO_HOME = '/env/path';
    initHome();
    expect(getHome()).toBe('/env/path');
  });

  it('expands tilde in LUMO_HOME env var', () => {
    const home = process.env.HOME || '';
    process.env.LUMO_HOME = '~/envdata';
    initHome();
    expect(getHome()).toBe(join(home, 'envdata'));
  });

  it('CLI argument takes precedence over LUMO_HOME', () => {
    process.env.LUMO_HOME = '/env/path';
    initHome('/cli/path');
    expect(getHome()).toBe('/cli/path');
  });

  it('LUMO_HOME takes precedence over platform default', () => {
    process.env.LUMO_HOME = '/env/path';
    initHome();
    expect(getHome()).not.toBe(getDefaultHome());
    expect(getHome()).toBe('/env/path');
  });

  it('caches the resolved value', () => {
    initHome('/first/path');
    expect(getHome()).toBe('/first/path');
    // Without reset, should still return cached value
    expect(getHome()).toBe('/first/path');
  });

  it('getHome returns platform default if initHome not called', () => {
    // getHome should fall back to platform default
    expect(getHome()).toBe(getDefaultHome());
  });
});

describe('ensureHome', () => {
  let tmpDir: string;
  const originalLumoHome = process.env.LUMO_HOME;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'paths-test-'));
    resetHome();
    delete process.env.LUMO_HOME;
  });

  afterEach(() => {
    resetHome();
    rmSync(tmpDir, { recursive: true, force: true });
    if (originalLumoHome === undefined) {
      delete process.env.LUMO_HOME;
    } else {
      process.env.LUMO_HOME = originalLumoHome;
    }
  });

  it('creates directory if it does not exist', () => {
    const newDir = join(tmpDir, 'new-home-dir');
    initHome(newDir);

    expect(existsSync(newDir)).toBe(false);
    ensureHome();
    expect(existsSync(newDir)).toBe(true);
  });

  it('creates directory with secure permissions (0o700)', () => {
    const newDir = join(tmpDir, 'secure-dir');
    initHome(newDir);
    ensureHome();

    const stats = statSync(newDir);
    // Check owner-only permissions (0o700 = rwx------)
    expect(stats.mode & 0o777).toBe(0o700);
  });

  it('does nothing if directory already exists', () => {
    // tmpDir already exists
    initHome(tmpDir);
    expect(() => ensureHome()).not.toThrow();
  });

  it('creates nested directories recursively', () => {
    const deepDir = join(tmpDir, 'a', 'b', 'c');
    initHome(deepDir);
    ensureHome();

    expect(existsSync(deepDir)).toBe(true);
  });
});

describe('getVaultPath and getConversationsDbPath', () => {
  const originalLumoHome = process.env.LUMO_HOME;

  beforeEach(() => {
    resetHome();
    delete process.env.LUMO_HOME;
  });

  afterEach(() => {
    resetHome();
    if (originalLumoHome === undefined) {
      delete process.env.LUMO_HOME;
    } else {
      process.env.LUMO_HOME = originalLumoHome;
    }
  });

  it('returns vault.enc in home directory', () => {
    initHome('/test/home');
    expect(getVaultPath()).toBe('/test/home/vault.enc');
  });

  it('returns home directory for conversations', () => {
    initHome('/test/home');
    expect(getConversationsDbPath()).toBe('/test/home');
  });
});

describe('getConfigPath', () => {
  const originalLumoHome = process.env.LUMO_HOME;

  beforeEach(() => {
    resetHome();
    delete process.env.LUMO_HOME;
  });

  afterEach(() => {
    resetHome();
    if (originalLumoHome === undefined) {
      delete process.env.LUMO_HOME;
    } else {
      process.env.LUMO_HOME = originalLumoHome;
    }
  });

  it('returns config.yaml in home directory', () => {
    initHome('/test/home');
    expect(getConfigPath()).toBe('/test/home/config.yaml');
  });
});

describe('getLogPath', () => {
  const originalLumoHome = process.env.LUMO_HOME;

  beforeEach(() => {
    resetHome();
    delete process.env.LUMO_HOME;
  });

  afterEach(() => {
    resetHome();
    if (originalLumoHome === undefined) {
      delete process.env.LUMO_HOME;
    } else {
      process.env.LUMO_HOME = originalLumoHome;
    }
  });

  it('returns log file in home directory', () => {
    initHome('/test/home');
    expect(getLogPath('lumo-tamer.log')).toBe('/test/home/lumo-tamer.log');
  });

  it('works with different log filenames', () => {
    initHome('/test/home');
    expect(getLogPath('lumo-tamer-cli.log')).toBe('/test/home/lumo-tamer-cli.log');
  });
});
