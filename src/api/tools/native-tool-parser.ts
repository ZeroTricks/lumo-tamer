/**
 * Helpers for parsing native SSE tool_call and tool_result JSON objects.
 *
 * Lumo's SSE stream sends tool calls via `target: 'tool_call'` with JSON content
 * like `{"name":"web_search","parameters":{"search_term":"..."}}`.
 * Tool results arrive via `target: 'tool_result'` with content like
 * `{"error":true}` (on failure) or actual result data (on success).
 *
 * Used for both legitimate native calls (e.g. web_search) and "misrouted" calls
 * (custom tools Lumo mistakenly routed through the native pipeline).
 */

import type { ParsedToolCall } from './types.js';
import { logger } from '../../app/logger.js';

/**
 * Parse a single complete JSON string as a native tool call.
 * Normalizes Lumo's `parameters` key to `arguments` for consistency with ParsedToolCall.
 * Returns null if JSON is invalid or doesn't contain a tool name.
 */
export function parseNativeToolCallJson(json: string): ParsedToolCall | null {
    try {
        const parsed = JSON.parse(json);
        if (typeof parsed !== 'object' || parsed === null || typeof parsed.name !== 'string') {
            return null;
        }

        // Lumo uses 'parameters', our ParsedToolCall uses 'arguments'
        const args = parsed.arguments ?? parsed.parameters ?? {};

        logger.debug({ tool: parsed.name }, 'Parsed native tool call');

        return {
            name: parsed.name,
            arguments: typeof args === 'object' && args !== null ? args : {},
        };
    } catch {
        return null;
    }
}

/**
 * Check if a complete tool_result JSON string indicates an error.
 * Returns true if the parsed JSON contains `"error": true`.
 */
export function isErrorResult(json: string): boolean {
    try {
        const parsed = JSON.parse(json);
        return typeof parsed === 'object' && parsed !== null && parsed.error === true;
    } catch {
        return false;
    }
}
