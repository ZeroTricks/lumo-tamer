/**
 * Tool call types and validation.
 */

import type { ParsedToolCall } from '../../lumo-client/types.js';

// Re-export from lumo-client (canonical source)
export type { ParsedToolCall };

function asObject(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      // ignore
    }
  }
  return {};
}

/**
 * Type guard to check if parsed JSON resembles a tool call.
 * Accepts both `arguments` and `parameters`, and nested OpenAI function shape.
 */
export function isToolCallJson(json: unknown): boolean {
  if (typeof json !== 'object' || json === null) return false;
  const obj = json as Record<string, unknown>;

  if ('type' in obj && obj.type !== 'function_call' && obj.type !== 'function') {
    return false;
  }

  if (typeof obj.name === 'string' && ('arguments' in obj || 'parameters' in obj)) return true;

  const fn = obj.function as Record<string, unknown> | undefined;
  if (fn && typeof fn === 'object' && typeof fn.name === 'string' && ('arguments' in fn || 'parameters' in fn)) {
    return true;
  }

  return false;
}

/**
 * Normalize tool-call-like JSON into ParsedToolCall.
 * Supports flat shape and OpenAI nested function shape.
 */
export function parseToolCallJson(json: unknown): ParsedToolCall | null {
  if (typeof json !== 'object' || json === null) return null;
  const obj = json as Record<string, unknown>;

  if (typeof obj.name === 'string') {
    const rawArgs = obj.arguments ?? obj.parameters;
    return { name: obj.name, arguments: asObject(rawArgs) };
  }

  const fn = obj.function as Record<string, unknown> | undefined;
  if (fn && typeof fn === 'object' && typeof fn.name === 'string') {
    const rawArgs = fn.arguments ?? fn.parameters;
    return { name: fn.name, arguments: asObject(rawArgs) };
  }

  return null;
}
