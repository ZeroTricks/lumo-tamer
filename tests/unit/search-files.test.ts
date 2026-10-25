import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { applySearchBlock, parseSearchQueries } from '../../src/cli/local-actions/search-files.js';

describe('parseSearchQueries', () => {
  it('skips blanks and comments', () => {
    expect(parseSearchQueries('river\n# ignore\nmoon')).toEqual(['river', 'moon']);
  });
});

describe('applySearchBlock', () => {
  it('finds text in source files and skips venv', async () => {
    const root = mkdtempSync(join(tmpdir(), 'search-files-'));
    try {
      writeFileSync(join(root, 'index.html'), 'a river and a moon');
      mkdirSync(join(root, '.venv'), { recursive: true });
      writeFileSync(join(root, '.venv', 'hidden.py'), 'river');
      const result = await applySearchBlock({ language: 'search', content: 'river' }, root);
      expect(result.success).toBe(true);
      expect(result.output).toContain('index.html');
      expect(result.output).not.toContain('hidden.py');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
