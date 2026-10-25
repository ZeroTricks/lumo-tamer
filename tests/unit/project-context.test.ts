import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { buildProjectSnapshot, detectAgentIntent, extractAtFiles, wantsProjectContext } from '../../src/cli/local-actions/project-context.js';

describe('wantsProjectContext', () => {
  it('matches review and folder requests', () => {
    expect(wantsProjectContext('review the current folder')).toBe(true);
    expect(wantsProjectContext('check if river and moon are implemented')).toBe(true);
    expect(wantsProjectContext('Hi')).toBe(false);
    expect(extractAtFiles('review @index.html')).toEqual(['index.html']);
    expect(detectAgentIntent('fix the river')).toBe('edit');
  });
});

describe('buildProjectSnapshot', () => {
  it('includes source files and skips venv', () => {
    const root = mkdtempSync(join(tmpdir(), 'project-context-'));
    try {
      writeFileSync(join(root, 'index.html'), '<html>river moon kitchen</html>');
      writeFileSync(join(root, 'README.md'), '# Mood Forest');
      mkdirSync(join(root, '.venv', 'lib'), { recursive: true });
      writeFileSync(join(root, '.venv', 'lib', 'junk.py'), 'secret');
      mkdirSync(join(root, 'node_modules'), { recursive: true });
      writeFileSync(join(root, 'node_modules', 'pkg.js'), 'ignore');

      const snapshot = buildProjectSnapshot(root, { maxFiles: 10, maxTotalBytes: 80_000 });
      expect(snapshot.fileCount).toBe(2);
      expect(snapshot.text).toContain('index.html');
      expect(snapshot.text).toContain('README.md');
      expect(snapshot.text).toContain('river moon kitchen');
      expect(snapshot.text).not.toContain('secret');
      expect(snapshot.text).not.toContain('ignore');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
