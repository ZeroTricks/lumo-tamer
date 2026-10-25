import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { applyEditBlock, applySearchReplace, parseEditBlock } from '../../src/cli/local-actions/edit-applier.js';
import { writeJournal } from '../../src/cli/local-actions/write-journal.js';

describe('applySearchReplace', () => {
  it('applies an exact unique match', () => {
    const result = applySearchReplace('hello world', 'world', 'there');
    expect(result).toEqual({ ok: true, next: 'hello there' });
  });

  it('applies a whitespace-tolerant match', () => {
    const result = applySearchReplace('hello world  \n', 'hello world', 'hi');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.next).toContain('hi');
  });

  it('rejects missing search text', () => {
    const result = applySearchReplace('hello', 'nope', 'x');
    expect(result.ok).toBe(false);
  });
});

describe('parseEditBlock', () => {
  it('parses multiple files', () => {
    const ops = parseEditBlock([
      '=== FILE: a.html',
      '<<<<<<< SEARCH',
      'old',
      '=======',
      'new',
      '>>>>>>> REPLACE',
      '=== FILE: b.md',
      '<<<<<<< SEARCH',
      'x',
      '=======',
      'y',
      '>>>>>>> REPLACE',
    ].join('\n'));
    expect(ops).toHaveLength(2);
    expect(ops[0]?.filename).toBe('a.html');
    expect(ops[1]?.filename).toBe('b.md');
  });
});

describe('applyEditBlock', () => {
  let root: string;
  let cwd: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'edit-applier-'));
    cwd = process.cwd();
    process.chdir(root);
    writeFileSync(join(root, 'a.txt'), 'alpha\n');
    writeFileSync(join(root, 'b.txt'), 'beta\n');
    writeJournal.clear();
  });

  afterEach(() => {
    process.chdir(cwd);
    rmSync(root, { recursive: true, force: true });
  });

  it('edits two files in one block and supports undo', async () => {
    const result = await applyEditBlock({
      language: 'edit',
      content: [
        '=== FILE: a.txt',
        '<<<<<<< SEARCH',
        'alpha',
        '=======',
        'ALPHA',
        '>>>>>>> REPLACE',
        '=== FILE: b.txt',
        '<<<<<<< SEARCH',
        'beta',
        '=======',
        'BETA',
        '>>>>>>> REPLACE',
      ].join('\n'),
    });
    expect(result.success).toBe(true);
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toContain('ALPHA');
    expect(readFileSync(join(root, 'b.txt'), 'utf8')).toContain('BETA');
    const undo = writeJournal.undo();
    expect(undo.restored.length).toBe(2);
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toContain('alpha');
  });
});
