/**
 * Tool call ID utilities
 *
 * - call_id format: `toolname__uuid` (embeds tool name for extraction)
 * - Completion tracking with deduplication
 * - Lumo-specific prefixing for function_call_output
 */

import { randomUUID } from 'crypto';
import { getCustomToolsConfig } from '../../app/config.js';
import { logger } from '../../app/logger.js';
import { getMetrics } from '../../app/metrics.js';

// ── Call ID generation ────────────────────────────────────────────────

/**
 * Generate a call_id for tool calls.
 * Format: `toolname__uuid` - embeds tool name for later extraction.
 */
export function generateCallId(toolName: string): string {
  return `${toolName}__${randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

/**
 * Extract tool name from call_id format: `toolname__uuid`.
 * Returns undefined if call_id doesn't match the expected format.
 */
export function extractToolNameFromCallId(callId: string): string | undefined {
  const match = callId.match(/^(.+)__[a-f0-9]+$/);
  return match?.[1];
}

// ── Completion tracking ───────────────────────────────────────────────

/**
 * Set of call_ids that have been tracked as completed.
 * Prevents double-counting on duplicate requests (both stateful and stateless).
 */
const completedCallIds = new Set<string>();

/**
 * Track completion of a custom tool call.
 * Extracts tool name from call_id format (toolname__uuid).
 * Deduplicates via completedCallIds Set.
 */
export function trackCustomToolCompletion(callId: string): void {
  if (completedCallIds.has(callId)) return;
  completedCallIds.add(callId);

  const toolName = extractToolNameFromCallId(callId);
  if (!toolName) return;

  logger.info({ toolName, call_id: callId }, 'Custom tool call completed');
  getMetrics()?.toolCallsTotal.inc({
    type: 'custom',
    status: 'completed',
    tool_name: toolName,
  });
}

// ── Lumo prefixing ────────────────────────────────────────────────────

/**
 * Add tool_name with prefix to function_call_output JSON for Lumo context.
 * Extracts tool name from call_id and re-prefixes it.
 */
export function addToolNameToFunctionOutput(content: string): string {
  try {
    const parsed = JSON.parse(content);
    if (parsed.type === 'function_call_output' && parsed.call_id) {
      const toolName = extractToolNameFromCallId(String(parsed.call_id));
      if (toolName) {
        const prefix = getCustomToolsConfig().prefix;
        const prefixedToolName = prefix ? `${prefix}${toolName}` : toolName;
        return JSON.stringify({
          ...parsed,
          tool_name: prefixedToolName,
        });
      }
    }
  } catch {
    // Not valid JSON, return as-is
  }
  return content;
}
