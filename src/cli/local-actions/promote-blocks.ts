/**
 * Turn ordinary markdown code fences into create blocks so the CLI
 * can save files even when Lumo refuses the create/edit protocol.
 */

import { FILE_PREFIX, type CodeBlock } from './types.js';

const FILE_INTENT = /\b(create|write|save|make|generate|add|put|build)\b|\b(website|webpage|html|page|site|animation|file|script|module|class|scene|app|program)\b|\b\w+\.(py|js|ts|tsx|jsx|kt|java|go|rs|sh|html|css|json|md|txt|yml|yaml)\b/i;

const FILE_LANGS = new Set(['html', 'css', 'javascript', 'js', 'typescript', 'ts', 'python', 'py', 'kotlin', 'kt', 'java']);

const REFUSAL = /can't go along with the setup|not going to adopt that framing|don't actually have local file|no [`']?lumo-tamer|won't pretend|i can't run code|i cannot run code|save and run yourself|nothing would happen except|repeating them in each message/i;

const EXT_BY_LANG: Record<string, string> = {
  python: 'py',
  py: 'py',
  javascript: 'js',
  js: 'js',
  typescript: 'ts',
  ts: 'ts',
  tsx: 'tsx',
  jsx: 'jsx',
  kotlin: 'kt',
  kt: 'kt',
  java: 'java',
  go: 'go',
  rust: 'rs',
  bash: 'sh',
  sh: 'sh',
  html: 'html',
  css: 'css',
  json: 'json',
};

const ACTION_LANGS = new Set(['create', 'edit', 'read', 'search']);

export function userWantsAFile(userText: string): boolean {
  return FILE_INTENT.test(userText);
}

export function looksLikeAccessRefusal(text: string): boolean {
  return REFUSAL.test(text);
}

export function inferFilename(userText: string, language: string | null, content: string): string {
  const fromUser = userText.match(/\b([\w./-]+\.(py|js|ts|tsx|jsx|kt|java|go|rs|sh|html|css|json|md|txt|yml|yaml))\b/i);
  if (fromUser) return fromUser[1];

  const first = content.split('\n')[0] ?? '';
  const fromComment = first.match(/(?:^#|^\/\/|^--|^\/\*)\s*([\w./-]+\.\w+)/);
  if (fromComment) return fromComment[1];

  const ext = (language && EXT_BY_LANG[language]) || 'txt';
  const fromTitle = userText.match(/\b(?:a|an|the)\s+([a-z][a-z0-9 ]{2,40}?)(?:\s+with|\s+that|\s+in|\s*$)/i);
  if (fromTitle) {
    const slug = fromTitle[1].trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
    if (slug) return `${slug}.${ext}`;
  }
  if (ext === 'html') return 'index.html';
  return `script.${ext}`;
}

function toCreateBlock(filename: string, content: string): CodeBlock {
  const body = content.startsWith(FILE_PREFIX) ? content : `${FILE_PREFIX} ${filename}\n${content}`;
  return { language: 'create', content: body };
}

/**
 * If Lumo pasted a normal language fence instead of ```create, promote it
 * so the CLI can save the file.
 */
export function extractFences(text: string): CodeBlock[] {
  const out: CodeBlock[] = [];
  const re = /```(\w*)\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    out.push({ language: match[1] || null, content: match[2].trim() });
  }
  return out;
}

export function promotePlainCodeBlocks(
  userText: string,
  blocks: CodeBlock[],
): CodeBlock[] {
  if (blocks.length === 0) return blocks;
  const wantsFile = userWantsAFile(userText);

  return blocks.map((block) => {
    const lang = block.language;
    if (!lang || ACTION_LANGS.has(lang)) return block;
    const lineCount = block.content.split('\n').length;
    const looksLikeFile = wantsFile
      || lineCount > 8
      || (lang !== null && FILE_LANGS.has(lang))
      || /^\s*(#|\/\/|<!DOCTYPE|<html)\s*/i.test(block.content);
    if (!looksLikeFile) return block;
    const filename = inferFilename(userText, lang, block.content);
    return toCreateBlock(filename, block.content);
  });
}

/** Promote detected blocks, and recover fences that were only shown as text. */
export function ensureActionBlocks(
  userText: string,
  assistantText: string,
  blocks: CodeBlock[],
): CodeBlock[] {
  const promoted = promotePlainCodeBlocks(userText, blocks);
  if (promoted.some((block) => block.language === 'create' || block.language === 'edit')) {
    return promoted;
  }
  const extras = extractFences(assistantText).filter((block) => {
    if (!block.language || ACTION_LANGS.has(block.language)) return false;
    return !blocks.some((existing) => existing.content === block.content);
  });
  if (extras.length === 0) return promoted;
  return promotePlainCodeBlocks(userText, [...promoted, ...extras]);
}

export const FILE_ACTION_NUDGE = 'Please put the complete source code in one fenced code block (for example ```python). Do not discuss tools or file access.';
