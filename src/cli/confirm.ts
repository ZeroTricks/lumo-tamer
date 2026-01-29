/**
 * User confirmation utility for CLI
 *
 * Generic yes/no/skip-all prompt, shared across block handlers.
 */

import type { Interface as ReadlineInterface } from 'readline';

export type ConfirmResult = 'yes' | 'no' | 'skip_all';

/**
 * Ask user confirmation using an existing readline interface.
 * Returns 'yes', 'no', or 'skip_all' (s = skip remaining blocks this turn).
 */
export async function confirm(rl: ReadlineInterface, prompt: string): Promise<ConfirmResult> {
  return new Promise((resolve) => {
    rl.question(`${prompt} [y/N/s(kip all)]: `, (answer) => {
      const a = answer.toLowerCase().trim();
      if (a === 'y' || a === 'yes') resolve('yes');
      else if (a === 's' || a === 'skip all' || a === 'skip') resolve('skip_all');
      else resolve('no');
    });
  });
}

/**
 * Show block content, confirm with user, apply if accepted.
 * Returns the result on success, 'skipped' if declined, or 'skip_all' to abort remaining blocks.
 */
export async function confirmAndApply<T>(
  rl: ReadlineInterface,
  options: {
    label: string;          // e.g. "Edit block detected"
    content: string;        // block content to display
    prompt: string;         // e.g. "Apply this edit?"
    verb: string;           // e.g. "Applying"
    errorLabel: string;     // e.g. "Patch error"
    apply: () => Promise<T>;
    formatOutput?: (result: T) => string; // extra output after apply (default: none)
  },
): Promise<T | 'skipped' | 'skip_all'> {
  process.stdout.write(`[${options.label}]\n`);
  process.stdout.write('─'.repeat(40) + '\n');
  process.stdout.write(options.content + '\n');
  process.stdout.write('─'.repeat(40) + '\n');

  const answer = await confirm(rl, options.prompt);
  if (answer === 'skip_all') return 'skip_all';
  if (answer !== 'yes') {
    process.stdout.write('[Skipped]\n\n');
    return 'skipped';
  }

  process.stdout.write(`[${options.verb}...]\n\n`);
  try {
    const result = await options.apply();
    if (options.formatOutput) {
      process.stdout.write(options.formatOutput(result) + '\n\n');
    }
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stdout.write(`[${options.errorLabel}: ${msg}]\n\n`);
    return 'skipped';
  }
}
