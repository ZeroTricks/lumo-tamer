/**
 * Tool prefix helpers
 *
 * Utilities for prefixing/stripping custom tool names.
 */

import type { OpenAITool } from '../types.js';

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


