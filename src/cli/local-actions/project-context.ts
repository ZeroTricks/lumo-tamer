/**
 * Attach a small slice of the current project so Lumo can review or edit
 * without being told it has a filesystem.
 */

import { readFileSync, statSync } from 'fs';
import { relative } from 'path';
import bytes from 'bytes';
import { FILE_PREFIX } from './types.js';
import { isBinaryFile } from './file-reader.js';
import { listSourceFiles, resolveProjectFile } from './paths-guard.js';
import { searchProject } from './search-files.js';

export type AgentIntent = 'review' | 'edit' | 'create' | 'run' | 'chat';

const REVIEW_INTENT =
  /\b(review|check|look(?:\s+at)?|inspect|explore|list|show|read|folder|directory|project|files?|cwd|implement|implemented|missing|animation|codebase|current (?:folder|dir|directory|project))\b/i;
const EDIT_INTENT = /\b(edit|fix|change|update|patch|replace|refactor)\b/i;
const CREATE_INTENT = /\b(create|write|scaffold|generate|make)\b/i;
const RUN_INTENT = /\b(run|execute|test|start|open)\b/i;

const STOP_WORDS = new Set([
  'review', 'check', 'look', 'inspect', 'explore', 'list', 'show', 'read',
  'folder', 'directory', 'project', 'files', 'file', 'current', 'please',
  'with', 'that', 'this', 'from', 'into', 'have', 'does', 'just', 'want',
  'need', 'make', 'the', 'and', 'for', 'are', 'its', 'all', 'can', 'you',
]);

export interface ProjectSnapshotOptions {
  maxFiles?: number;
  maxTotalBytes?: number;
  maxFileBytes?: number;
}

export interface ProjectSnapshot {
  root: string;
  fileCount: number;
  files: string[];
  text: string;
}

export function detectAgentIntent(text: string): AgentIntent {
  if (RUN_INTENT.test(text) && !EDIT_INTENT.test(text) && !CREATE_INTENT.test(text)) return 'run';
  if (EDIT_INTENT.test(text)) return 'edit';
  if (CREATE_INTENT.test(text)) return 'create';
  if (REVIEW_INTENT.test(text) || extractAtFiles(text).length > 0) return 'review';
  return 'chat';
}

export function wantsProjectContext(text: string): boolean {
  const intent = detectAgentIntent(text);
  return intent !== 'chat' || extractAtFiles(text).length > 0;
}

export function extractAtFiles(text: string): string[] {
  const found = text.match(/@([\w./-]+)/g) ?? [];
  return [...new Set(found.map((item) => item.slice(1)))];
}

export function extractKeywords(text: string): string[] {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9_\s.-]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length >= 4 && !STOP_WORDS.has(word));
  return [...new Set(words)].slice(0, 8);
}

function readTextFile(absolute: string, maxFileBytes: number): string | undefined {
  try {
    if (statSync(absolute).size > maxFileBytes) return undefined;
    if (isBinaryFile(absolute)) return undefined;
    return readFileSync(absolute, 'utf8');
  } catch {
    return undefined;
  }
}

function addFileSection(
  sections: string[],
  included: string[],
  root: string,
  absolute: string,
  content: string,
): void {
  const rel = relative(root, absolute) || absolute;
  if (included.includes(rel)) return;
  included.push(rel);
  sections.push(`${FILE_PREFIX} ${rel}\n${content}`);
}

export function buildProjectSnapshot(root: string, options: ProjectSnapshotOptions = {}): ProjectSnapshot {
  return buildAgentContext(root, 'review the current folder', options);
}

export function buildAgentContext(
  root: string,
  userText: string,
  options: ProjectSnapshotOptions = {},
): ProjectSnapshot {
  const maxFiles = options.maxFiles ?? 24;
  const maxTotalBytes = options.maxTotalBytes ?? 80 * 1024;
  const maxFileBytes = options.maxFileBytes ?? 100 * 1024;
  const all = listSourceFiles(root, Math.max(maxFiles, 80));
  const tree = all.length > 0
    ? all.map((file) => relative(root, file) || file).join('\n')
    : '(no source files found)';

  const sections: string[] = [`Files:\n${tree}`];
  const included: string[] = [];
  let used = 0;

  const take = (absolute: string): void => {
    if (included.length >= maxFiles || used >= maxTotalBytes) return;
    const content = readTextFile(absolute, maxFileBytes);
    if (content === undefined) return;
    const size = Buffer.byteLength(content);
    if (used + size > maxTotalBytes) return;
    addFileSection(sections, included, root, absolute, content);
    used += size;
  };

  for (const mention of extractAtFiles(userText)) {
    const resolved = resolveProjectFile(mention, root);
    if (resolved.ok) take(resolved.absolute);
  }

  const keywords = extractKeywords(userText);
  if (keywords.length > 0 && included.length < maxFiles) {
    const ranked = new Map<string, number>();
    for (const keyword of keywords) {
      for (const hit of searchProject(root, keyword, 12)) {
        ranked.set(hit.file, (ranked.get(hit.file) ?? 0) + 1);
      }
    }
    const ordered = [...ranked.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([file]) => file);
    for (const rel of ordered) {
      const resolved = resolveProjectFile(rel, root);
      if (resolved.ok) take(resolved.absolute);
    }
  }

  if (included.length === 0) {
    for (const file of all.slice(0, maxFiles)) {
      take(file);
    }
  }

  return {
    root,
    fileCount: included.length,
    files: included,
    text: sections.join('\n\n'),
  };
}

export function snapshotLimitsFromConfig(config: {
  projectContext: { maxFiles: number; maxTotalSize: string | number };
  fileReads: { maxFileSize: string | number };
}): ProjectSnapshotOptions {
  return {
    maxFiles: config.projectContext.maxFiles,
    maxTotalBytes: parseByteLimit(config.projectContext.maxTotalSize),
    maxFileBytes: parseByteLimit(config.fileReads.maxFileSize),
  };
}

export function parseByteLimit(value: string | number): number {
  if (typeof value === 'number') return value;
  return bytes.parse(value) ?? 80 * 1024;
}
