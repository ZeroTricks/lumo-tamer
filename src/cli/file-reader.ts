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

import { readFileSync, statSync, openSync, readSync, closeSync } from 'fs';
import type { CodeBlock, BlockHandler } from './block-handlers.js';
import { FILE_PREFIX } from './edit-applier.js';
import { getToolsConfig } from '../app/config.js';

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

const BINARY_CHECK_BYTES = 8192;

/**
 * Check if a file appears to be binary by looking for null bytes
 * in the first 8KB. Same heuristic used by Git.
 */
export function isBinaryFile(filePath: string): boolean {
  const fd = openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(BINARY_CHECK_BYTES);
    const bytesRead = readSync(fd, buffer, 0, BINARY_CHECK_BYTES, 0);
    for (let i = 0; i < bytesRead; i++) {
      if (buffer[i] === 0x00) return true;
    }
    return false;
  } finally {
    closeSync(fd);
  }
}

/**
 * Get file size in KB.
 */
export function getFileSizeKB(filePath: string): number {
  return statSync(filePath).size / 1024;
}

/**
 * Read files listed in a read block and return their contents.
 */
export async function applyReadBlock(block: CodeBlock): Promise<ReadResult> {
  const { fileReads } = getToolsConfig();
  const maxFileSizeKB = fileReads.maxFileSizeKB;

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
      // Guard: file size
      const sizeKB = getFileSizeKB(path);
      if (sizeKB > maxFileSizeKB) {
        allSuccess = false;
        sections.push(
          `${FILE_PREFIX} ${path}\nError: File too large (${Math.round(sizeKB)} KB). Maximum allowed size is ${maxFileSizeKB} KB.`
        );
        continue;
      }

      // Guard: binary detection
      if (isBinaryFile(path)) {
        allSuccess = false;
        sections.push(
          `${FILE_PREFIX} ${path}\nError: File appears to be binary. Only text files can be read.`
        );
        continue;
      }

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
  apply: (block) => {
    if (!getToolsConfig().fileReads.enabled) {
      return Promise.resolve({
        type: 'read',
        success: false,
        output: 'File reads are disabled in configuration (tools.fileReads.enabled)',
        files: [],
      } as ReadResult);
    }
    return applyReadBlock(block);
  },
  formatApplyOutput: (result) => result.output,
  formatResult: (_block, result) =>
    result.success
      ? `File contents:\n${result.output}`
      : `File read failed:\n${result.output}`,
};
