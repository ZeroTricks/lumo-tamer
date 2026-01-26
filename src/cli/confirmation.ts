/**
 * Simple user confirmation prompt for CLI
 */

import type { Interface as ReadlineInterface } from 'readline';

/**
 * Ask user yes/no confirmation using an existing readline interface
 */
export async function confirm(rl: ReadlineInterface, prompt: string): Promise<boolean> {
  return new Promise((resolve) => {
    rl.question(`${prompt} [y/N]: `, (answer) => {
      resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
    });
  });
}
