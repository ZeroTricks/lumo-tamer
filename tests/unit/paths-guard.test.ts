import { describe, it, expect } from 'vitest';
import { isSecretPath, resolveProjectFile } from '../../src/cli/local-actions/paths-guard.js';

describe('isSecretPath', () => {
  it('rejects env and key files', () => {
    expect(isSecretPath('.env')).toBe(true);
    expect(isSecretPath('.env.local')).toBe(true);
    expect(isSecretPath('id_rsa')).toBe(true);
    expect(isSecretPath('index.html')).toBe(false);
  });
});

describe('resolveProjectFile', () => {
  it('accepts a relative file inside cwd', () => {
    const resolved = resolveProjectFile('index.html', '/tmp/project');
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.relative).toBe('index.html');
  });

  it('rejects a path outside cwd', () => {
    const resolved = resolveProjectFile('../secret.txt', '/tmp/project');
    expect(resolved.ok).toBe(false);
  });
});
