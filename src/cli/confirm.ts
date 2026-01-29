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
