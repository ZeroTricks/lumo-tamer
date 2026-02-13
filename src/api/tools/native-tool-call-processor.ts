/**
 * Processes native tool calls from Lumo's SSE tool_call/tool_result targets.
 *
 * Lumo's SSE stream sends tool calls via `target: 'tool_call'` with JSON content
 * like `{"name":"web_search","parameters":{"search_term":"..."}}`.
 * Tool results arrive via `target: 'tool_result'` with content like
 * `{"error":true}` (on failure) or actual result data (on success).
 *
 * This processor:
 * - Parses streaming JSON via JsonBraceTracker
 * - Detects misrouted custom tools (custom tools Lumo mistakenly routed through native pipeline)
 * - Tracks success/failure metrics
 */

import { JsonBraceTracker } from './json-brace-tracker.js';
import { stripToolPrefix } from './prefix.js';
import { getCustomToolsConfig } from '../../app/config.js';
import { getMetrics } from '../metrics/index.js';
import { logger } from '../../app/logger.js';
import type { ParsedToolCall } from './types.js';

const KNOWN_NATIVE_TOOLS = new Set([
  'proton_info', 'web_search', 'weather', 'stock', 'cryptocurrency'
]);

// ── Internal helpers ─────────────────────────────────────────────────

/**
 * Parse a single complete JSON string as a native tool call.
 * Normalizes Lumo's `parameters` key to `arguments` for consistency with ParsedToolCall.
 * Returns null if JSON is invalid or doesn't contain a tool name.
 */
function parseToolCallJson(json: string): ParsedToolCall | null {
  try {
    const parsed = JSON.parse(json);
    if (typeof parsed !== 'object' || parsed === null || typeof parsed.name !== 'string') {
      return null;
    }

    // Lumo uses 'parameters', our ParsedToolCall uses 'arguments'
    const args = parsed.arguments ?? parsed.parameters ?? {};

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
function isErrorResult(json: string): boolean {
  try {
    const parsed = JSON.parse(json);
    return typeof parsed === 'object' && parsed !== null && parsed.error === true;
  } catch {
    return false;
  }
}

// ── Exported types and class ─────────────────────────────────────────

export interface NativeToolCallResult {
  toolCall: ParsedToolCall | undefined;
  failed: boolean;
  /** True if a misrouted custom tool was detected */
  misrouted: boolean;
}

/**
 * Processes native tool calls from Lumo's SSE tool_call/tool_result targets.
 * Detects misrouted custom tools and tracks metrics.
 */
export class NativeToolCallProcessor {
  private toolCallTracker = new JsonBraceTracker();
  private toolResultTracker = new JsonBraceTracker();
  private firstToolCall: ParsedToolCall | null = null;
  private failed = false;
  private _misrouted = false;

  constructor(
    /** When true, ignore misrouted detection (for bounce responses) */
    private isBounce = false
  ) {}

  /** Feed tool_call SSE content. Returns true if should abort early. */
  feedToolCall(content: string): boolean {
    for (const json of this.toolCallTracker.feed(content)) {
      const toolCall = parseToolCallJson(json);
      if (!toolCall) continue;

      // Save first for result (used by bounce logic)
      if (!this.firstToolCall) {
        this.firstToolCall = toolCall;
      }

      if (this.isMisrouted(toolCall)) {
        const strippedName = stripToolPrefix(toolCall.name, getCustomToolsConfig().prefix);
        getMetrics()?.toolCallsTotal.inc({
          type: 'custom', status: 'misrouted', tool_name: strippedName
        });
        logger.debug({ tool: toolCall.name, isBounce: this.isBounce }, 'Misrouted tool call detected');

        // Only abort on first misroute in non-bounce mode.
        // Note: This means we may undercount if Lumo queues multiple misrouted calls
        // in one response. The bounce response will count any subsequent retries.
        if (!this.isBounce && toolCall === this.firstToolCall) {
          this._misrouted = true;
          return true;
        }
      } else {
        // Native tool - no success/failed distinction (unreliable)
        getMetrics()?.toolCallsTotal.inc({
          type: 'native', status: 'detected', tool_name: toolCall.name
        });
        logger.debug({ raw: json }, 'Native SSE tool_call');
      }
    }
    return false;
  }

  /** Feed tool_result SSE content. */
  feedToolResult(content: string): void {
    for (const json of this.toolResultTracker.feed(content)) {
      logger.debug({ raw: json }, 'Native SSE tool_result');
      if (this.firstToolCall && !this.failed && isErrorResult(json)) {
        this.failed = true;
      }
    }
  }

  /** Finalize processing. Call after stream ends. */
  finalize(): void {
    // Metrics tracked per tool call in feedToolCall()
  }

  /** Get the result after stream completes. */
  getResult(): NativeToolCallResult {
    return {
      toolCall: this.firstToolCall ?? undefined,
      failed: this.failed,
      misrouted: this._misrouted,
    };
  }

  private isMisrouted(toolCall: ParsedToolCall): boolean {
    return !KNOWN_NATIVE_TOOLS.has(toolCall.name);
  }
}
