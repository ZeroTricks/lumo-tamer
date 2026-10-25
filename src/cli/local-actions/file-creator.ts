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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { FILE_PREFIX, type BlockHandler, type CodeBlock } from './types.js';
import { resolveProjectFile } from './paths-guard.js';
import { writeJournal } from './write-journal.js';
import { getLocalActionsConfig } from '../../app/config.js';

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

  const rawName = firstLine.slice(FILE_PREFIX.length).trim();
  if (!rawName) {
    return { type: 'create', success: false, output: 'Empty filename in === FILE: header', files: [] };
  }

  let restrict = true;
  try {
    restrict = getLocalActionsConfig().restrictToCwd;
  } catch {
    restrict = true;
  }
  const resolved = restrict
    ? resolveProjectFile(rawName)
    : { ok: true as const, absolute: rawName, relative: rawName };
  if (!resolved.ok) {
    return { type: 'create', success: false, output: resolved.error, files: [rawName] };
  }

  const filename = resolved.absolute;
  const fileContent = lines.slice(1).join('\n');

  try {
    const dir = dirname(filename);
    if (dir && dir !== '.') {
      mkdirSync(dir, { recursive: true });
    }

    const existed = existsSync(filename);
    const previous = existed ? readFileSync(filename, 'utf8') : null;
    writeFileSync(filename, fileContent, 'utf8');
    writeJournal.record([{ path: filename, previous }]);

    const action = existed ? 'overwritten' : 'created';
    return {
      type: 'create',
      success: true,
      output: `${resolved.relative}: ${action} successfully`,
      files: [resolved.relative],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      type: 'create',
      success: false,
      output: `${resolved.relative}: ${msg}`,
      files: [resolved.relative],
    };
  }
}

export const createHandler: BlockHandler = {
  matches: (block) => block.language === 'create',
  summarize: (block) => summarizeCreateBlock(block.content),
  requiresConfirmation: true,
  confirmOptions: (block) => {
    const firstLine = block.content.split('\n')[0] ?? '';
    const targetPath = firstLine.startsWith(FILE_PREFIX)
      ? firstLine.slice(FILE_PREFIX.length).trim()
      : undefined;
    return {
      label: 'Create block detected',
      prompt: 'Create this file?',
      verb: 'Creating',
      errorLabel: 'Create error',
      kind: 'create',
      targetPath,
    };
  },
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
