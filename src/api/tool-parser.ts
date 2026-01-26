/**
 * Parses tool calls from Lumo response text.
 *
 * Supports multiple formats:
 * - Code blocks: ```json {...} ```
 * - Raw JSON: {...}
 * - Legacy <pre> tags: <pre>...</pre>
 */

import { logger } from '../app/logger.js';

export interface ParsedToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * Type guard to check if parsed JSON is a valid tool call.
 * Valid tool calls must have `name` (string) and `arguments` (object).
 */
export function isToolCallJson(json: unknown): json is { name: string; arguments: unknown } {
  return (
    typeof json === 'object' &&
    json !== null &&
    'name' in json &&
    typeof (json as Record<string, unknown>).name === 'string' &&
    'arguments' in json
  );
}

/**
 * Extract tool calls from response text.
 *
 * Supports multiple formats:
 * 1. Code blocks: ```json {"name":"...", "arguments":{}} ```
 * 2. Raw JSON: {"name":"...", "arguments":{}}
 * 3. Legacy <pre> tags: <pre>{"name":"...", "arguments":{}}</pre>
 *
 * @param text - The full response text from Lumo
 * @returns Array of parsed tool calls, or null if none found
 */
export function extractToolCallsFromResponse(text: string): ParsedToolCall[] | null {
  const results: ParsedToolCall[] = [];

  // Pattern 1: Code blocks (```json ... ```)
  const codeBlockRegex = /```(?:json)?\s*\n?([\s\S]*?)```/gi;
  let match;
  while ((match = codeBlockRegex.exec(text)) !== null) {
    const toolCall = tryParseAsToolCall(match[1].trim());
    if (toolCall) results.push(toolCall);
  }

  // Pattern 2: <pre> tags (legacy)
  const preTagRegex = /<pre[^>]*>([\s\S]*?)<\/pre>/gi;
  while ((match = preTagRegex.exec(text)) !== null) {
    const toolCall = tryParseAsToolCall(match[1].trim());
    if (toolCall) results.push(toolCall);
  }

  // Pattern 3: Raw JSON objects (standalone on a line)
  // Match JSON objects that look like tool calls
  const rawJsonRegex = /(?:^|\n)\s*(\{[\s\S]*?"name"\s*:\s*"[^"]+"\s*[\s\S]*?"arguments"\s*:[\s\S]*?\})\s*(?:\n|$)/g;
  while ((match = rawJsonRegex.exec(text)) !== null) {
    const toolCall = tryParseAsToolCall(match[1].trim());
    if (toolCall) results.push(toolCall);
  }

  return results.length > 0 ? results : null;
}

/**
 * Try to parse content as a tool call.
 */
function tryParseAsToolCall(content: string): ParsedToolCall | null {
  try {
    const parsed = JSON.parse(content);
    if (isToolCallJson(parsed)) {
      logger.info(`Tool call detected: ${content.replace(/\n/g," ").substring(0, 100)}...`)
      return {
        name: parsed.name,
        arguments: parsed.arguments as Record<string, unknown>,
      };
    }
  } catch {
        logger.info(`Invalid tool call: ${content.replace(/\n/g," ").substring(0, 100)}...`)
    // Not valid JSON
  }
  return null;
}

/**
 * Strip tool call JSON from response text.
 * Removes code blocks, <pre> tags, and raw JSON that contain tool calls.
 *
 * @param text - The full response text
 * @param toolCalls - Previously extracted tool calls (used to identify what to strip)
 * @returns Text with tool call JSON removed
 */
export function stripToolCallsFromResponse(text: string, toolCalls: ParsedToolCall[]): string {
  if (!toolCalls || toolCalls.length === 0) {
    return text;
  }

  // Create a set of tool call JSON strings for matching
  const toolCallJsons = new Set(toolCalls.map(tc => JSON.stringify({ name: tc.name, arguments: tc.arguments })));

  let result = text;

  // Helper to check if content matches a known tool call
  const isMatchingToolCall = (content: string): boolean => {
    try {
      const parsed = JSON.parse(content.trim());
      if (parsed?.name && parsed?.arguments) {
        const jsonStr = JSON.stringify({ name: parsed.name, arguments: parsed.arguments });
        return toolCallJsons.has(jsonStr);
      }
    } catch {
      // Not valid JSON
    }
    return false;
  };

  // Strip code blocks
  result = result.replace(/```(?:json)?\s*\n?([\s\S]*?)```/gi, (match, content) => {
    return isMatchingToolCall(content) ? '' : match;
  });

  // Strip <pre> tags
  result = result.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (match, content) => {
    return isMatchingToolCall(content) ? '' : match;
  });

  // Strip raw JSON (more careful - only if standalone)
  result = result.replace(/(?:^|\n)\s*(\{[\s\S]*?"name"\s*:\s*"[^"]+"\s*[\s\S]*?"arguments"\s*:[\s\S]*?\})\s*(?:\n|$)/g, (match, content) => {
    return isMatchingToolCall(content) ? '\n' : match;
  });

  return result.trim();
}
