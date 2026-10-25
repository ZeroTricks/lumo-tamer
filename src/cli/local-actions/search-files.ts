/**
 * Project search for CLI (```search blocks and agent context).
 */

import { readFileSync } from 'fs';
import { relative } from 'path';
import { spawnSync } from 'child_process';
import { getLocalActionsConfig } from '../../app/config.js';
import { FILE_PREFIX, type BlockHandler, type CodeBlock } from './types.js';
import { isBinaryFile } from './file-reader.js';
import { listSourceFiles } from './paths-guard.js';

export interface SearchHit {
  file: string;
  line: number;
  text: string;
}

export interface SearchResult {
  type: 'search';
  success: boolean;
  output: string;
  hits: SearchHit[];
}

export function parseSearchQueries(content: string): string[] {
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

function searchWithRipgrep(root: string, query: string, maxResults: number): SearchHit[] | undefined {
  const result = spawnSync(
    'rg',
    ['-n', '-I', '--no-ignore', '--no-config', '--hidden', '--glob', '!.git', '--glob', '!.venv', '--glob', '!node_modules', '-m', String(maxResults), '-e', query, root],
    { encoding: 'utf8', timeout: 8000 },
  );
  if (result.error || result.status === 127) {
    return undefined;
  }
  if (result.status !== 0 && result.status !== 1) {
    return undefined;
  }
  const hits: SearchHit[] = [];
  for (const line of (result.stdout || '').split('\n')) {
    if (!line) continue;
    const match = line.match(/^(.*?):(\d+):(.*)$/);
    if (!match) continue;
    hits.push({
      file: relative(root, match[1]) || match[1],
      line: Number(match[2]),
      text: match[3].trim(),
    });
    if (hits.length >= maxResults) break;
  }
  return hits;
}

function searchByWalk(root: string, query: string, maxResults: number): SearchHit[] {
  const needle = query.toLowerCase();
  const hits: SearchHit[] = [];
  for (const file of listSourceFiles(root, 200)) {
    if (isBinaryFile(file)) continue;
    let content = '';
    try {
      content = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const rel = relative(root, file) || file;
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].toLowerCase().includes(needle)) continue;
      hits.push({ file: rel, line: i + 1, text: lines[i].trim() });
      if (hits.length >= maxResults) return hits;
    }
  }
  return hits;
}

export function searchProject(root: string, query: string, maxResults = 40): SearchHit[] {
  if (!query.trim()) return [];
  const fromRg = searchWithRipgrep(root, query, maxResults);
  if (fromRg && fromRg.length > 0) return fromRg;
  return searchByWalk(root, query, maxResults);
}

export function formatSearchHits(query: string, hits: SearchHit[]): string {
  if (hits.length === 0) {
    return `No matches for: ${query}`;
  }
  const lines = hits.map((hit) => `${hit.file}:${hit.line}: ${hit.text}`);
  return `Matches for ${query}:\n${lines.join('\n')}`;
}

export async function applySearchBlock(block: CodeBlock, root = process.cwd()): Promise<SearchResult> {
  const queries = parseSearchQueries(block.content);
  if (queries.length === 0) {
    return { type: 'search', success: false, output: 'No search query in block', hits: [] };
  }

  let maxResults = 40;
  try {
    maxResults = getLocalActionsConfig().search.maxResults;
  } catch {
    // unit tests without full CLI config
  }

  const allHits: SearchHit[] = [];
  const sections: string[] = [];
  for (const query of queries) {
    const hits = searchProject(root, query, maxResults);
    allHits.push(...hits);
    sections.push(formatSearchHits(query, hits));
  }

  return {
    type: 'search',
    success: true,
    output: sections.join('\n\n'),
    hits: allHits,
  };
}

export const searchHandler: BlockHandler = {
  matches: (block) => block.language === 'search',
  summarize: (block) => `[search: ${parseSearchQueries(block.content).join(', ') || '?'}]\n`,
  requiresConfirmation: false,
  confirmOptions: () => ({
    label: '',
    prompt: '',
    verb: '',
    errorLabel: '',
    kind: 'create',
  }),
  apply: (block) => applySearchBlock(block),
  formatApplyOutput: (result) => result.output,
  formatResult: (_block, result) =>
    result.success
      ? `${FILE_PREFIX} search\n${result.output}`
      : `Search failed:\n${result.output}`,
};
