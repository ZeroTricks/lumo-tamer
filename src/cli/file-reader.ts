/**
 * File reader block handler for CLI
 *
 * Reads files from ```read blocks and returns contents to Lumo.
 * No user confirmation needed
 * No output to user, avoids cluttering the terminal.
 *
 * Format:
 *   path/to/file1.txt
 *   path/to/file2.txt
 */

import { readFileSync } from 'fs';
import type { CodeBlock, BlockHandler } from './block-handlers.js';
import { FILE_PREFIX } from './edit-applier.js';

export interface ReadResult {
  type: 'read';
  success: boolean;
  output: string;
  files: string[];
}

export function isReadBlock(block: CodeBlock): boolean {
  return block.language === 'read';
}

/**
 * One-line summary of a read block for streaming display.
 * e.g. "[read: file1.txt, file2.txt]"
 */
export function summarizeReadBlock(content: string): string {
  const paths = content.split('\n').map(l => l.trim()).filter(Boolean);
  return `[read: ${paths.join(', ')}]\n`;
}

/**
 * Read files listed in a read block and return their contents.
 */
export async function applyReadBlock(block: CodeBlock): Promise<ReadResult> {
  const paths = block.content.split('\n').map(l => l.trim()).filter(Boolean);

  if (paths.length === 0) {
    return { type: 'read', success: false, output: 'No file paths found in read block', files: [] };
  }

  const sections: string[] = [];
  const files: string[] = [];
  let allSuccess = true;

  for (const path of paths) {
    files.push(path);
    try {
      const content = readFileSync(path, 'utf8');
      sections.push(`${FILE_PREFIX} ${path}\n${content}`);
    } catch (err) {
      allSuccess = false;
      const msg = err instanceof Error ? err.message : String(err);
      sections.push(`${FILE_PREFIX} ${path}\nError: ${msg}`);
    }
  }

  return {
    type: 'read',
    success: allSuccess,
    output: sections.join('\n\n'),
    files,
  };
}

export const readHandler: BlockHandler = {
  matches: (block) => block.language === 'read',
  summarize: (block) => summarizeReadBlock(block.content),
  requiresConfirmation: false,
  confirmOptions: () => ({ label: '', prompt: '', verb: '', errorLabel: '' }),
  apply: (block) => applyReadBlock(block),
  formatResult: (_block, result) =>
    result.success
      ? `File contents:\n${result.output}`
      : `File read failed:\n${result.output}`,
};
