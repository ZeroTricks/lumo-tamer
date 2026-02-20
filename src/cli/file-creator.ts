/**
 * File creator block handler for CLI
 *
 * Creates new files from ```create blocks.
 * Requires user confirmation before writing.
 * One file per block.
 *
 * Format:
 *   === FILE: path/to/new-file.txt
 *   file contents here
 *   line 2
 *   ...
 */

import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import type { BlockHandler } from './types.js';
import type { CodeBlock } from './types.js';
import { FILE_PREFIX } from './types.js';

export interface CreateResult {
  type: 'create';
  success: boolean;
  output: string;
  files: string[];
}

export function isCreateBlock(block: CodeBlock): boolean {
  return block.language === 'create';
}

/**
 * One-line summary of a create block for streaming display.
 * e.g. "[create: path/to/file.txt (25 lines)]"
 */
export function summarizeCreateBlock(content: string): string {
  const firstLine = content.split('\n')[0] ?? '';
  const filename = firstLine.startsWith(FILE_PREFIX)
    ? firstLine.slice(FILE_PREFIX.length).trim()
    : '?';
  const lines = content.split('\n').length - 1; // subtract header line
  return `[create: ${filename} (${lines} lines)]\n`;
}

/**
 * Parse and apply a create block: write a new file.
 */
export async function applyCreateBlock(block: CodeBlock): Promise<CreateResult> {
  const lines = block.content.split('\n');
  const firstLine = lines[0] ?? '';

  if (!firstLine.startsWith(FILE_PREFIX)) {
    return { type: 'create', success: false, output: 'Missing === FILE: header', files: [] };
  }

  const filename = firstLine.slice(FILE_PREFIX.length).trim();
  if (!filename) {
    return { type: 'create', success: false, output: 'Empty filename in === FILE: header', files: [] };
  }

  const fileContent = lines.slice(1).join('\n');

  try {
    // Create parent directories if needed
    const dir = dirname(filename);
    if (dir && dir !== '.') {
      mkdirSync(dir, { recursive: true });
    }

    const existed = existsSync(filename);
    writeFileSync(filename, fileContent, 'utf8');

    const action = existed ? 'overwritten' : 'created';
    return {
      type: 'create',
      success: true,
      output: `${filename}: ${action} successfully`,
      files: [filename],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      type: 'create',
      success: false,
      output: `${filename}: ${msg}`,
      files: [filename],
    };
  }
}

export const createHandler: BlockHandler = {
  matches: (block) => block.language === 'create',
  summarize: (block) => summarizeCreateBlock(block.content),
  requiresConfirmation: true,
  confirmOptions: () => ({
    label: 'Create block detected',
    prompt: 'Create this file?',
    verb: 'Creating',
    errorLabel: 'Create error',
  }),
  apply: (block) => applyCreateBlock(block),
  formatApplyOutput: (result) => result.output,
  formatResult: (_block, result) => {
    const r = result as CreateResult;
    const status = r.success
      ? `File created: ${r.files.join(', ')}`
      : 'File creation failed';
    return `${status}:\n${r.output}`;
  },
};
