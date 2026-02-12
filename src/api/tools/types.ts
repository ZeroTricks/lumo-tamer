/**
 * Tool call types and validation.
 */

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
