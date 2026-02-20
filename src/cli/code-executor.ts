/**
 * Code block executor for CLI
 *
 * Executes bash code blocks and streams output to callback.
 */

import { spawn } from 'child_process';
import type { CodeBlock, BlockHandler } from './types.js';
import { getLocalActionsConfig } from '../app/config.js';

export interface ExecutionResult {
  type: 'execution';
  success: boolean;
  output: string; // stdout + stderr combined
  exitCode: number | null;
}

/**
 * One-line summary of an executable block for streaming display.
 * e.g. "[bash: echo hello\n... (10 lines)]"
 */
export function summarizeExecutableBlock(language: string | null, content: string): string {
  const lines = content.split('\n');
  const preview = lines.length <= 3
    ? content
    : lines.slice(0, 3).join('\n') + `\n... (${lines.length} lines)`;
  return `[${language || 'code'}: ${preview}]\n`;
}

/**
 * Check if a code block language is executable (has a shell mapping in config)
 */
export function isExecutable(language: string | null): boolean {
  if (!language) return false;
  const { executors } = getLocalActionsConfig();
  return language in executors;
}

/**
 * Execute a code block and stream output to callback
 */
export async function executeBlock(
  block: CodeBlock,
  onOutput: (chunk: string) => void
): Promise<ExecutionResult> {
  const { executors } = getLocalActionsConfig();
  const executor = block.language ? executors[block.language] : undefined;

  if (!executor) {
    return {
      type: 'execution',
      success: false,
      output: `Unsupported language: ${block.language}`, exitCode: null
    };
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
      resolve({
        type: 'execution',
        success: code === 0,
        output, exitCode: code
      });
    });

    proc.on('error', (err) => {
      resolve({
        type: 'execution',
        success: false,
        output: err.message, exitCode: null
      });
    });
  });
}

export const executeHandler: BlockHandler = {
  matches: (block) => isExecutable(block.language),
  summarize: (block) => summarizeExecutableBlock(block.language, block.content),
  requiresConfirmation: true,
  confirmOptions: (block) => ({
    label: `Code block detected: ${block.language || 'code'}`,
    prompt: 'Execute this code?',
    verb: 'Executing',
    errorLabel: 'Execution error',
  }),
  apply: (block) => executeBlock(block, (chunk) => process.stdout.write(chunk)),
  formatApplyOutput: (result) => `[Exit code: ${(result as ExecutionResult).exitCode}]`,
  formatResult: (block, result) => {
    const r = result as ExecutionResult;
    const lang = block.language || 'code';
    const status = r.success
      ? `${lang} executed successfully (exit code 0)`
      : `${lang} failed (exit code ${r.exitCode})`;
    return `${status}:\n\`\`\`\n${r.output}\`\`\``;
  },
};
