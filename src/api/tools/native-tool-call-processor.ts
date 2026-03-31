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
 * - Builds ContentBlock[] for interleaved tool calls/results
 * - Detects misrouted custom tools (custom tools Lumo mistakenly routed through native pipeline)
 * - Tracks success/failure metrics
 */

import { JsonBraceTracker } from './json-brace-tracker.js';
import { stripToolPrefix } from './prefix.js';
import { getCustomToolPrefix } from '../../app/config.js';
import { getMetrics } from '../../app/metrics.js';
import { logger } from '../../app/logger.js';
import type { ParsedToolCall } from './types.js';
import type { ContentBlock } from '@lumo/types.js';
import { setToolCallInBlocks, setToolResultInBlocks } from '@lumo/messageHelpers.js';

const KNOWN_NATIVE_TOOLS = new Set([
  'proton_info', 'web_search', 'weather', 'stock', 'cryptocurrency'
]);

// ── Internal helpers ─────────────────────────────────────────────────

/**
 * Parse a single complete JSON string as a native tool call.
 * Normalizes Lumo's `parameters` key to `arguments` for consistency with ParsedToolCall.
 * Returns null if JSON is invalid or doesn't contain a tool name.
 *
 * Handles Lumo's internal format quirk where `arguments` may be an object containing
 * `{arguments, name, parameters}` - in that case, extract `parameters` from the nested structure.
 */
function parseToolCallJson(json: string): ParsedToolCall | null {
  try {
    const parsed = JSON.parse(json);
    if (typeof parsed !== 'object' || parsed === null || typeof parsed.name !== 'string') {
      return null;
    }

    // Lumo uses 'parameters', our ParsedToolCall uses 'arguments'
    let args = parsed.arguments ?? parsed.parameters ?? {};

    // Handle Lumo's internal format quirk: if arguments contains nested {arguments, name, parameters},
    // extract the actual parameters from that nested structure
    if (typeof args === 'object' && args !== null && 'parameters' in args && typeof args.parameters === 'object') {
      args = args.parameters ?? {};
    }

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
  /** ContentBlocks for tool calls/results (may be empty) */
  blocks: ContentBlock[];
  /** First tool call detected (for bounce handling) */
  toolCall: ParsedToolCall | undefined;
  failed: boolean;
  /** True if a misrouted custom tool was detected */
  misrouted: boolean;
}

/**
 * Processes native tool calls from Lumo's SSE tool_call/tool_result targets.
 * Builds ContentBlocks and detects misrouted custom tools.
 */
export class NativeToolCallProcessor {
  private toolCallTracker = new JsonBraceTracker();
  private toolResultTracker = new JsonBraceTracker();
  private blocks: ContentBlock[] = [];
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

      // Save first for bounce logic
      if (!this.firstToolCall) {
        this.firstToolCall = toolCall;
      }

      if (this.isMisrouted(toolCall)) {
        const strippedName = stripToolPrefix(toolCall.name, getCustomToolPrefix());
        getMetrics()?.toolCallsTotal.inc({
          type: 'custom', status: 'misrouted', tool_name: strippedName
        });
        logger.debug({ tool: toolCall.name, isBounce: this.isBounce }, 'Misrouted tool call detected');

        // Only abort on first misroute in non-bounce mode.
        if (!this.isBounce && toolCall === this.firstToolCall) {
          this._misrouted = true;
          return true;
        }
      } else {
        // Native tool - add to blocks
        this.blocks = setToolCallInBlocks(this.blocks, json);
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
      // Add to blocks
      this.blocks = setToolResultInBlocks(this.blocks, json);
      // Track failure status
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
      blocks: this.blocks,
      toolCall: this.firstToolCall ?? undefined,
      failed: this.failed,
      misrouted: this._misrouted,
    };
  }

  private isMisrouted(toolCall: ParsedToolCall): boolean {
    return !KNOWN_NATIVE_TOOLS.has(toolCall.name);
  }
}
