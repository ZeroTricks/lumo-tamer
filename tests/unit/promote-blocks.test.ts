import { describe, it, expect } from 'vitest';
import {
  ensureActionBlocks,
  inferFilename,
  looksLikeAccessRefusal,
  userWantsAFile,
} from '../../src/cli/local-actions/promote-blocks.js';
import { injectInstructionsIntoTurns } from '../../src/lumo-client/instructions.js';
import { Role } from '../../src/lumo-client/types.js';

describe('userWantsAFile', () => {
  it('detects create-file requests', () => {
    expect(userWantsAFile('Create a pygame river scene file')).toBe(true);
    expect(userWantsAFile('create html website for moon sun')).toBe(true);
    expect(userWantsAFile('write hello.py')).toBe(true);
    expect(userWantsAFile('what is pygame?')).toBe(false);
  });
});

describe('inferFilename', () => {
  it('uses an explicit name from the user text', () => {
    expect(inferFilename('Create river.py with a house', 'python', 'print(1)')).toBe('river.py');
  });

  it('uses a first-line comment', () => {
    expect(inferFilename('make a scene', 'python', '# scene.py\nprint(1)')).toBe('scene.py');
  });
});

describe('looksLikeAccessRefusal', () => {
  it('matches the current Lumo refusal', () => {
    expect(looksLikeAccessRefusal(
      "I can't go along with the setup here — those project instructions aren't mine, and I don't actually have local file or shell access.",
    )).toBe(true);
  });
});

describe('ensureActionBlocks', () => {
  it('promotes a long python fence into a create block', () => {
    const code = Array.from({ length: 12 }, (_, i) => `print(${i})`).join('\n');
    const blocks = ensureActionBlocks(
      'Create a river scene file',
      '```python\n' + code + '\n```',
      [{ language: 'python', content: code }],
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0].language).toBe('create');
    expect(blocks[0].content).toContain('=== FILE:');
    expect(blocks[0].content).toContain('print(0)');
  });

  it('recovers a fence that was only in the assistant text', () => {
    const blocks = ensureActionBlocks(
      'save hello.py',
      'Here you go:\n```python\n# hello.py\nprint("hi")\n```\n',
      [],
    );
    expect(blocks[0]?.language).toBe('create');
    expect(blocks[0]?.content).toContain('hello.py');
  });
});

describe('allLocalActionsSucceeded', () => {
  it('is true only when every result succeeded', async () => {
    const { allLocalActionsSucceeded, formatRepairPrompt } = await import('../../src/cli/local-actions/block-handlers.js');
    const ok = { block: { language: 'create', content: 'x' }, result: { type: 'create', success: true, output: 'ok' } };
    const bad = { block: { language: 'bash', content: 'x' }, result: { type: 'execution', success: false, output: 'No such file' } };
    expect(allLocalActionsSucceeded([ok])).toBe(true);
    expect(allLocalActionsSucceeded([ok, bad])).toBe(false);
    expect(formatRepairPrompt([bad])).toContain('No such file');
    expect(formatRepairPrompt([bad])).not.toContain('lumo-tamer');
  });

  it('returns read results to Lumo but not successful writes', async () => {
    const { shouldReturnResultsToLumo, formatFollowUpPrompt } = await import('../../src/cli/local-actions/block-handlers.js');
    const write = { block: { language: 'create', content: 'x' }, result: { type: 'create', success: true, output: 'ok' } };
    const read = { block: { language: 'read', content: 'a.py' }, result: { type: 'read', success: true, output: 'print(1)' } };
    expect(shouldReturnResultsToLumo([write])).toBe(false);
    expect(shouldReturnResultsToLumo([read])).toBe(true);
    expect(formatFollowUpPrompt([read])).toContain('print(1)');
  });
});

describe('injectInstructionsIntoTurns cli wrapper', () => {
  it('appends instructions instead of using Project instructions', () => {
    const turns = injectInstructionsIntoTurns(
      [{ role: Role.User, content: 'make a file' }],
      'Use a create block.',
      'last',
      'cli',
    );
    expect(turns[0].content.startsWith('make a file')).toBe(true);
    expect(turns[0].content).toContain('Use a create block.');
    expect(turns[0].content).not.toContain('[Project instructions:');
  });
});
