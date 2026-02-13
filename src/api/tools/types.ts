/**
 * Tool call types and validation.
 */

export interface ParsedToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * Type guard to check if parsed JSON is a valid tool call.
 * Accepts both formats:
 * - { name, arguments }
 * - { type: 'function_call', name, arguments }
 */
export function isToolCallJson(json: unknown): json is { name: string; arguments: unknown; type?: string } {
  if (typeof json !== 'object' || json === null) return false;
  const obj = json as Record<string, unknown>;
  if (typeof obj.name !== 'string' || !('arguments' in obj)) return false;
  if ('type' in obj && obj.type !== 'function_call') return false;
  return true;
}
