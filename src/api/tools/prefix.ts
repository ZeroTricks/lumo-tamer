/**
 * Tool prefix helpers and pattern replacement
 *
 * Utilities for prefixing/stripping custom tool names
 * and applying replace patterns.
 */

import type { OpenAITool } from '../types.js';

// Re-export template helper
export { interpolateTemplate } from './template.js';

// ── Prefix helpers ───────────────────────────────────────────────────

/**
 * Apply prefix to tool names in tool definitions.
 * Returns a new array with prefixed tool names.
 */
export function applyToolPrefix(tools: OpenAITool[], prefix: string): OpenAITool[] {
  if (!prefix || !tools) return tools;
  return tools.map(tool => {
    // Handle nested format: { type: "function", function: { name: "..." } }
    if (tool?.function?.name) {
      return {
        ...tool,
        function: {
          ...tool.function,
          name: `${prefix}${tool.function.name}`,
        },
      };
    }
    // Handle flat format: { type: "function", name: "..." } (e.g., Home Assistant)
    const flat = tool as unknown as { name?: string };
    if (flat?.name) {
      return { ...tool, name: `${prefix}${flat.name}` } as unknown as OpenAITool;
    }
    return tool;
  });
}

/**
 * Strip prefix from a tool name.
 * If the name doesn't have the prefix, returns it unchanged.
 */
export function stripToolPrefix(name: string, prefix: string): string {
  if (!prefix) return name;
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

// ── Regex helpers ────────────────────────────────────────────────────

/**
 * Escape special regex characters in a string.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Apply prefix to tool names appearing in text.
 * Only prefixes tool names that match the provided list exactly (word boundaries).
 * Skips names that are already prefixed.
 */
export function applyToolNamePrefix(
  text: string,
  toolNames: string[],
  prefix: string
): string {
  if (!prefix || !text || !toolNames || toolNames.length === 0) return text;

  let result = text;
  for (const name of toolNames) {
    // Match tool name at word boundaries, skip if already prefixed
    const regex = new RegExp(`(?<!${escapeRegex(prefix)})\\b${escapeRegex(name)}\\b`, 'g');
    result = result.replace(regex, `${prefix}${name}`);
  }
  return result;
}

// ── Pattern replacement ──────────────────────────────────────────────

export interface ReplacePattern {
  pattern: string;
  replacement?: string;
}

/**
 * Apply replace patterns to text (case-insensitive regex).
 * Each pattern can have an optional replacement; if omitted, matches are stripped.
 */
export function applyReplacePatterns(text: string, patterns: ReplacePattern[]): string {
  if (!patterns || patterns.length === 0) return text;
  let result = text;
  for (const { pattern, replacement } of patterns) {
    try {
      const regex = new RegExp(pattern, 'gi');
      result = result.replace(regex, replacement ?? '');
    } catch {
      // Invalid regex pattern - skip it (already warned at config load)
    }
  }
  // Clean up multiple consecutive newlines/spaces left by removals
  return result.replace(/\n{3,}/g, '\n\n').replace(/  +/g, ' ').trim();
}

