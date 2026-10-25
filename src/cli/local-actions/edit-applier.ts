/**
 * Search/replace edit block applier for CLI
 *
 * Parses ```edit blocks with search/replace format and applies edits.
 * Multiple === FILE sections are allowed in one block.
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { DIVIDER, FILE_PREFIX, REPLACE_MARKER, SEARCH_MARKER, type BlockHandler, type CodeBlock } from './types.js';
import { resolveProjectFile } from './paths-guard.js';
import { writeJournal } from './write-journal.js';
import { getLocalActionsConfig } from '../../app/config.js';

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

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function summarizeEditBlock(content: string): string {
  const files = [...content.matchAll(new RegExp(`^${escapeRegExp(FILE_PREFIX)}\\s*(.+)$`, 'gm'))]
    .map((match) => match[1].trim());
  const unique = [...new Set(files)];
  return `[edit: ${unique.join(', ') || '?'}]\n`;
}

export function formatUnifiedDiff(filename: string, search: string, replace: string): string {
  const del = search.split('\n').map((line) => `-${line}`).join('\n');
  const add = replace.split('\n').map((line) => `+${line}`).join('\n');
  return `--- ${filename}\n+++ ${filename}\n${del}\n${add}`;
}

export function formatEditPreview(content: string): string {
  const operations = parseEditBlock(content);
  if (operations.length === 0) return content;
  return operations.map((op) => formatUnifiedDiff(op.filename, op.search, op.replace)).join('\n\n');
}

export function parseEditBlock(content: string): EditOperation[] {
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

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

function normalizeWhitespace(text: string): string {
  return normalizeNewlines(text)
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n');
}

/**
 * Apply search/replace. Exact first, then newline/whitespace-tolerant if unique.
 */
export function applySearchReplace(source: string, search: string, replace: string):
  | { ok: true; next: string }
  | { ok: false; error: string } {
  const exact = source.split(search).length - 1;
  if (exact === 1) {
    return { ok: true, next: source.replace(search, replace) };
  }
  if (exact > 1) {
    return { ok: false, error: `search text found ${exact} times (ambiguous)` };
  }

  const sourceNorm = normalizeWhitespace(source);
  const searchNorm = normalizeWhitespace(search);
  const count = sourceNorm.split(searchNorm).length - 1;
  if (count === 0) {
    return { ok: false, error: 'search text not found' };
  }
  if (count > 1) {
    return { ok: false, error: `search text found ${count} times (ambiguous)` };
  }

  const start = sourceNorm.indexOf(searchNorm);
  // Map normalized offset back by walking original lines is hard; rewrite via normalized text.
  const replacedNorm = sourceNorm.replace(searchNorm, normalizeWhitespace(replace));
  return { ok: true, next: replacedNorm };
}

function restrictWrites(): boolean {
  try {
    return getLocalActionsConfig().restrictToCwd;
  } catch {
    return true;
  }
}

export async function applyEditBlock(block: CodeBlock): Promise<EditResult> {
  const operations = parseEditBlock(block.content);
  if (operations.length === 0) {
    return { type: 'edit', success: false, output: 'No edit operations found in block', files: [] };
  }

  const results: string[] = [];
  const files: string[] = [];
  const snapshots: { path: string; previous: string | null }[] = [];
  let allSuccess = true;

  for (const op of operations) {
    const resolved = restrictWrites()
      ? resolveProjectFile(op.filename)
      : { ok: true as const, absolute: op.filename, relative: op.filename };
    if (!resolved.ok) {
      allSuccess = false;
      results.push(`${op.filename}: ${resolved.error}`);
      continue;
    }

    const filename = resolved.absolute;
    if (!existsSync(filename)) {
      allSuccess = false;
      results.push(`${resolved.relative}: file not found`);
      continue;
    }

    try {
      const source = readFileSync(filename, 'utf8');
      const applied = applySearchReplace(source, op.search, op.replace);
      if (!applied.ok) {
        allSuccess = false;
        results.push(`${resolved.relative}: ${applied.error}`);
        continue;
      }
      snapshots.push({ path: filename, previous: source });
      writeFileSync(filename, applied.next, 'utf8');
      files.push(resolved.relative);
      results.push(`${resolved.relative}: edited successfully`);
    } catch (err) {
      allSuccess = false;
      const msg = err instanceof Error ? err.message : String(err);
      results.push(`${resolved.relative}: ${msg}`);
    }
  }

  if (snapshots.length > 0) {
    writeJournal.record(snapshots);
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
  preview: (block) => formatEditPreview(block.content),
  requiresConfirmation: true,
  confirmOptions: (block) => {
    const files = parseEditBlock(block.content).map((op) => op.filename);
    return {
      label: 'Edit block detected',
      prompt: files.length > 1 ? `Apply edits to ${files.length} files?` : 'Apply this edit?',
      verb: 'Applying',
      errorLabel: 'Patch error',
      kind: 'edit',
      targetPath: files[0],
    };
  },
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
