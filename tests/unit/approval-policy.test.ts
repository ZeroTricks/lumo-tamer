import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { ApprovalPolicy } from '../../src/cli/local-actions/approval-policy.js';
import { parseConfirmAnswer } from '../../src/cli/local-actions/confirm.js';

describe('parseConfirmAnswer', () => {
  it('maps once / skip / help keys', () => {
    expect(parseConfirmAnswer('y')).toBe('yes');
    expect(parseConfirmAnswer('n')).toBe('no');
    expect(parseConfirmAnswer('')).toBe('no');
    expect(parseConfirmAnswer('s')).toBe('skip_all');
    expect(parseConfirmAnswer('?')).toBe('help');
  });

  it('keeps A (session) distinct from a (this turn)', () => {
    expect(parseConfirmAnswer('a')).toBe('all_turn');
    expect(parseConfirmAnswer('A')).toBe('session');
    expect(parseConfirmAnswer('session')).toBe('session');
  });

  it('maps file and project scopes', () => {
    expect(parseConfirmAnswer('f')).toBe('file');
    expect(parseConfirmAnswer('p')).toBe('project');
  });
});

describe('ApprovalPolicy', () => {
  it('approves one file for the rest of the session', () => {
    const policy = new ApprovalPolicy('/tmp/proj');
    policy.remember('file', 'src/Main.kt');
    expect(policy.autoApproveReason('edit', 'src/Main.kt')).toBe('file');
    expect(policy.autoApproveReason('create', 'src/Other.kt')).toBeUndefined();
    expect(policy.autoApproveReason('execute')).toBeUndefined();
  });

  it('approves project writes but not paths outside the root', () => {
    const policy = new ApprovalPolicy('/tmp/proj');
    policy.remember('project');
    expect(policy.autoApproveReason('create', 'app/Hello.kt')).toBe('project');
    expect(policy.autoApproveReason('edit', join('/tmp/proj', 'app/Hello.kt'))).toBe('project');
    expect(policy.autoApproveReason('create', '../outside.txt')).toBeUndefined();
    expect(policy.autoApproveReason('execute', 'app/Hello.kt')).toBeUndefined();
  });

  it('session file writes do not auto-run shell, but this-turn does', () => {
    const policy = new ApprovalPolicy('/tmp/proj');
    policy.remember('session');
    expect(policy.autoApproveReason('create', 'a.py')).toBe('session');
    expect(policy.autoApproveReason('execute')).toBeUndefined();
    policy.remember('all_turn');
    expect(policy.autoApproveReason('execute')).toBe('remaining this turn');
    policy.resetTurn();
    expect(policy.autoApproveReason('execute')).toBeUndefined();
    expect(policy.autoApproveReason('edit', 'a.py')).toBe('session');
  });
});
