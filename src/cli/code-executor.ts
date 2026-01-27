/**
 * Code block executor for CLI
 *
 * Executes bash code blocks and streams output to callback.
 */

import { spawn } from 'child_process';
import type { Interface as ReadlineInterface } from 'readline';
import type { CodeBlock } from './code-block-detector.js';
import { getToolsConfig } from '../app/config.js';

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
 * Check if a code block language is executable (has a shell mapping in config)
 */
export function isExecutable(language: string | null): boolean {
  if (!language) return false;
  const { executors } = getToolsConfig();
  return language in executors;
}

/**
 * Execute a code block and stream output to callback
 */
export async function executeBlock(
  block: CodeBlock,
  onOutput: (chunk: string) => void
): Promise<ExecutionResult> {
  const { executors } = getToolsConfig();
  const executor = block.language ? executors[block.language] : undefined;

  if (!executor) {
    return { success: false, output: `Unsupported language: ${block.language}`, exitCode: null };
  }

  const [cmd, ...args] = executor;

  return new Promise((resolve) => {
    const proc = spawn(cmd, [...args, block.content], {
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
