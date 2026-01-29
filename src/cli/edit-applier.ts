/**
 * Search/replace edit block applier for CLI
 *
 * Parses ```edit blocks with search/replace format and applies edits to a single file.
 * Uses git-conflict-style delimiters that LLMs handle reliably.
 * One file per edit block; use multiple blocks for multiple files.
 *
 * Format:
 *   === FILE: path/to/file.txt
 *   <<<<<<< SEARCH
 *   old text
 *   =======
 *   new text
 *   >>>>>>> REPLACE
 */

import { readFileSync, writeFileSync } from 'fs';
import type { CodeBlock, BlockHandler } from './block-handlers.js';

// Edit block delimiters. If changed, update cli.instructions.forTools in config.defaults.yaml.
export const FILE_PREFIX = '=== FILE:';
const SEARCH_MARKER = '<<<<<<< SEARCH';
const DIVIDER = '=======';
const REPLACE_MARKER = '>>>>>>> REPLACE';

export interface EditResult {
  type: 'edit';
  success: boolean;
  output: string;
  files: string[];
}

interface EditOperation {
  filename: string;
  search: string;
  replace: string;
}

export function isEditBlock(block: CodeBlock): boolean {
  return block.language === 'edit';
}

/**
 * One-line summary of an edit block for streaming display.
 * e.g. "[edit: file.txt (−3 +5)]"
 */
export function summarizeEditBlock(content: string): string {
  const fileRe = new RegExp(`^${escapeRegExp(FILE_PREFIX)}\\s*(.+)$`, 'm');
  const searchRe = new RegExp(`^${escapeRegExp(SEARCH_MARKER)}\\n([\\s\\S]*?)^${escapeRegExp(DIVIDER)}`, 'm');
  const replaceRe = new RegExp(`^${escapeRegExp(DIVIDER)}([\\s\\S]*?)^${escapeRegExp(REPLACE_MARKER)}`, 'm');
  const file = content.match(fileRe)?.[1] ?? '?';
  const search = content.match(searchRe)?.[1] ?? '';
  const replace = content.match(replaceRe)?.[1] ?? '';
  const del = search.split('\n').length - 1;
  const add = replace.split('\n').length - 1;
  return `[edit: ${file} (−${del} +${add})]\n`;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Parse an edit block into individual edit operations.
 */
function parseEditBlock(content: string): EditOperation[] {
  const operations: EditOperation[] = [];
  const lines = content.split('\n');

  let currentFile: string | null = null;
  let state: 'idle' | 'search' | 'replace' = 'idle';
  let searchLines: string[] = [];
  let replaceLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith(FILE_PREFIX)) {
      currentFile = line.slice(FILE_PREFIX.length).trim();
      continue;
    }

    if (line.startsWith(SEARCH_MARKER)) {
      state = 'search';
      searchLines = [];
      continue;
    }

    if (line === DIVIDER && state === 'search') {
      state = 'replace';
      replaceLines = [];
      continue;
    }

    if (line.startsWith(REPLACE_MARKER)) {
      if (currentFile) {
        operations.push({
          filename: currentFile,
          search: searchLines.join('\n'),
          replace: replaceLines.join('\n'),
        });
      }
      state = 'idle';
      continue;
    }

    if (state === 'search') {
      searchLines.push(line);
    } else if (state === 'replace') {
      replaceLines.push(line);
    }
  }

  return operations;
}

/**
 * Apply an edit block to local files.
 */
export async function applyEditBlock(block: CodeBlock): Promise<EditResult> {
  let operations: EditOperation[];
  try {
    operations = parseEditBlock(block.content);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      type: 'edit',
      success: false,
      output: `Failed to parse edit block: ${msg}`,
      files: []
    };
  }

  if (operations.length === 0) {
    return {
      type: 'edit',
      success: false,
      output: 'No edit operations found in block',
      files: []
    };
  }

  const uniqueFiles = [...new Set(operations.map(op => op.filename))];
  if (uniqueFiles.length > 1) {
    return {
      type: 'edit',
      success: false,
      output: `Edit block contains multiple files (${uniqueFiles.join(',')}). Use one edit block per file.`, files: uniqueFiles };
  }

  const results: string[] = [];
  const files: string[] = uniqueFiles;
  let allSuccess = true;

  for (const op of operations) {

    try {
      const source = readFileSync(op.filename, 'utf8');

      const occurrences = source.split(op.search).length - 1;
      if (occurrences === 0) {
        allSuccess = false;
        results.push(`${ op.filename }: search text not found`);
        continue;
      }
      if (occurrences > 1) {
        allSuccess = false;
        results.push(`${ op.filename }: search text found ${ occurrences } times(ambiguous)`);
        continue;
      }

      const patched = source.replace(op.search, op.replace);
      writeFileSync(op.filename, patched, 'utf8');
      results.push(`${ op.filename }: edited successfully`);
    } catch (err) {
      allSuccess = false;
      const msg = err instanceof Error ? err.message : String(err);
      results.push(`${ op.filename }: ${ msg } `);
    }
  }

  return {
    type: 'edit',
    success: allSuccess,
    output: results.join('\n'),
    files,
  };
}

export const editHandler: BlockHandler = {
  matches: (block) => block.language === 'edit',
  summarize: (block) => summarizeEditBlock(block.content),
  requiresConfirmation: true,
  confirmOptions: () => ({
    label: 'Edit block detected',
    prompt: 'Apply this edit?',
    verb: 'Applying',
    errorLabel: 'Patch error',
  }),
  apply: (block) => applyEditBlock(block),
  formatApplyOutput: (result) => result.output,
  formatResult: (_block, result) => {
    const r = result as EditResult;
    const status = r.success
      ? `Edit applied successfully to: ${r.files.join(', ')}`
      : 'Edit failed';
    return `${status}:\n${r.output}`;
  },
};
