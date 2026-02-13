/**
 * Tracks native tool calls from Lumo's SSE tool_call/tool_result targets.
 * Detects misrouted custom tools (custom tools Lumo mistakenly routed
 * through its native SSE pipeline) and tracks metrics.
 */

import { JsonBraceTracker } from './json-brace-tracker.js';
import { parseNativeToolCallJson, isErrorResult } from './native-tool-parser.js';
import { stripToolPrefix } from './prefix.js';
import { getCustomToolsConfig } from '../../app/config.js';
import { getMetrics } from '../metrics/index.js';
import { logger } from '../../app/logger.js';
import type { ParsedToolCall } from './types.js';

const KNOWN_NATIVE_TOOLS = new Set([
  'proton_info', 'web_search', 'weather', 'stock', 'cryptocurrency'
]);

export interface NativeToolResult {
  toolCall: ParsedToolCall | undefined;
  failed: boolean;
  /** True if a misrouted custom tool was detected */
  misrouted: boolean;
}

/**
 * Tracks native tool calls from Lumo's SSE tool_call/tool_result targets.
 * Detects misrouted custom tools and tracks metrics.
 */
export class NativeToolTracker {
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
      if (!this.firstToolCall) {
        this.firstToolCall = parseNativeToolCallJson(json);
        if (this.firstToolCall) {
          if (this.isMisrouted(this.firstToolCall) && !this.isBounce) {
            this._misrouted = true;
            const strippedName = stripToolPrefix(
              this.firstToolCall.name,
              getCustomToolsConfig().prefix
            );
            getMetrics()?.toolCallsTotal.inc({
              type: 'custom', status: 'misrouted', tool_name: strippedName
            });
            logger.debug({ tool: this.firstToolCall.name }, 'Misrouted tool call detected');
            return true; // abort
          }
          logger.debug({ raw: json }, 'Native SSE tool_call');
        }
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

  /** Finalize and track metrics. Call after stream ends. */
  finalize(): void {
    if (this.firstToolCall && !this._misrouted) {
      const status = this.failed ? 'failed' : 'success';
      getMetrics()?.toolCallsTotal.inc({
        type: 'native', status, tool_name: this.firstToolCall.name
      });
      logger.debug({ toolCall: this.firstToolCall, failed: this.failed }, 'Lumo native tool call');
    }
  }

  /** Get the result after stream completes. */
  getResult(): NativeToolResult {
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
