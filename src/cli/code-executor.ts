/**
 * Code block executor for CLI
 *
 * Executes bash code blocks and streams output to callback.
 */

import { spawn } from 'child_process';
import type { Interface as ReadlineInterface } from 'readline';
import type { CodeBlock } from './code-block-detector.js';

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

export interface ExecutionResult {
  success: boolean;
  output: string; // stdout + stderr combined
  exitCode: number | null;
}

/**
 * Check if a code block language is executable
 */
export function isExecutable(language: string | null): boolean {
  return language === 'bash' || language === 'sh' || language === null;
}

/**
 * Execute a code block and stream output to callback
 */
export async function executeBlock(
  block: CodeBlock,
  onOutput: (chunk: string) => void
): Promise<ExecutionResult> {
  if (!isExecutable(block.language)) {
    return { success: false, output: `Unsupported language: ${block.language}`, exitCode: null };
  }

  return new Promise((resolve) => {
    const proc = spawn('bash', ['-c', block.content], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let output = '';

    proc.stdout.on('data', (data) => {
      const text = data.toString();
      output += text;
      onOutput(text);
    });

    proc.stderr.on('data', (data) => {
      const text = data.toString();
      output += text;
      onOutput(text); // Show errors too
    });

    proc.on('close', (code) => {
      resolve({ success: code === 0, output, exitCode: code });
    });

    proc.on('error', (err) => {
      resolve({ success: false, output: err.message, exitCode: null });
    });
  });
}
