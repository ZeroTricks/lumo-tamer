/**
 * User confirmation utility for CLI
 *
 * y = this action
 * n = skip this action
 * f = this file for the rest of the session
 * p = this project for the rest of the session (create/edit only)
 * A = all file writes for the rest of the session
 * a = remaining actions this turn
 * s = skip remaining actions this turn
 */

import type { Interface as ReadlineInterface } from 'readline';
import { print } from '../../app/terminal.js';
import { cliStatus } from '../../app/status-line.js';
import { approvalPolicy, type ActionKind } from './approval-policy.js';
import type { BlockResult } from './types.js';

export type ConfirmResult =
  | 'yes'
  | 'no'
  | 'skip_all'
  | 'all_turn'
  | 'file'
  | 'project'
  | 'session'
  | 'help';

const HELP_TEXT = [
  'y  apply this action once',
  'n  skip this action',
  'f  allow this file for the rest of the session',
  'p  allow all file writes in this project for the rest of the session',
  'A  allow all file writes for the rest of the session',
  'a  apply remaining actions this turn (including shell)',
  's  skip remaining actions this turn',
].join('\n');

export function parseConfirmAnswer(answer: string): ConfirmResult | 'unknown' {
  const raw = answer.trim();
  const a = raw.toLowerCase();
  if (raw === 'A') return 'session';
  if (a === 'y' || a === 'yes') return 'yes';
  if (a === 'n' || a === 'no' || a === '') return 'no';
  if (a === 's' || a === 'skip' || a === 'skip all') return 'skip_all';
  if (a === 'a' || a === 'all') return 'all_turn';
  if (a === 'f' || a === 'file') return 'file';
  if (a === 'p' || a === 'project') return 'project';
  if (a === 'session' || a === 'all session') return 'session';
  if (a === '?' || a === 'h' || a === 'help') return 'help';
  return 'unknown';
}

function promptSuffix(kind: ActionKind): string {
  return kind === 'execute'
    ? '[y/N/a/s] (? help)'
    : '[y/N/f/p/A/a/s] (? help)';
}

/**
 * Ask user confirmation using an existing readline interface.
 */
export async function confirm(
  rl: ReadlineInterface,
  prompt: string,
  kind: ActionKind = 'create',
): Promise<Exclude<ConfirmResult, 'help'>> {
  for (;;) {
    const answer = await new Promise<string>((resolve) => {
      rl.question(`${prompt} ${promptSuffix(kind)}: `, resolve);
    });
    const parsed = parseConfirmAnswer(answer);
    if (parsed === 'help' || parsed === 'unknown') {
      print(HELP_TEXT);
      continue;
    }
    return parsed;
  }
}

/**
 * Show block content, confirm with user, apply if accepted.
 * Returns the result on success, 'skipped' if declined, or 'skip_all' to abort remaining blocks.
 */
export async function confirmAndApply<T extends BlockResult>(
  rl: ReadlineInterface,
  options: {
    label: string;
    content: string;
    prompt: string;
    verb: string;
    errorLabel: string;
    kind: ActionKind;
    targetPath?: string;
    apply: () => Promise<T>;
    formatOutput?: (result: T) => string;
  },
): Promise<T | 'skipped' | 'skip_all'> {
  const reason = approvalPolicy.autoApproveReason(options.kind, options.targetPath);
  if (reason) {
    print(`[${options.label}] auto-approved (${reason})`);
    return applyQuietly(options);
  }

  print(`[${options.label}]`);
  print('─'.repeat(40));
  print(options.content);
  print('─'.repeat(40));

  const answer = await confirm(rl, options.prompt, options.kind);
  if (answer === 'skip_all') return 'skip_all';
  if (answer === 'no') {
    print('[Skipped]\n');
    return 'skipped';
  }

  if (answer === 'file' || answer === 'project' || answer === 'session' || answer === 'all_turn') {
    if (answer === 'file' && !options.targetPath) {
      print('No file path on this action; applying once.');
    } else {
      approvalPolicy.remember(answer, options.targetPath);
      if (answer === 'file') print(`Allowing ${options.targetPath} for this session.`);
      if (answer === 'project') print('Allowing file writes in this project for this session.');
      if (answer === 'session') print('Allowing all file writes for this session. Shell commands still ask.');
      if (answer === 'all_turn') print('Applying remaining actions this turn.');
    }
  }

  return applyQuietly(options);
}

async function applyQuietly<T extends BlockResult>(options: {
  verb: string;
  errorLabel: string;
  apply: () => Promise<T>;
  formatOutput?: (result: T) => string;
}): Promise<T | 'skipped'> {
  cliStatus.start(options.verb);
  try {
    const result = await options.apply();
    cliStatus.stop();
    if (options.formatOutput) {
      print(options.formatOutput(result) + '\n');
    }
    return result;
  } catch (err) {
    cliStatus.stop();
    const msg = err instanceof Error ? err.message : String(err);
    print(`[${options.errorLabel}: ${msg}]\n`);
    return 'skipped';
  }
}
