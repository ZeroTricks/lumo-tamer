/**
 * ServerTool Execution
 *
 * Executes ServerTools with error handling and logging.
 * Provides helpers for partitioning and building continuation turns.
 */

import { logger } from '../../../app/logger.js';
import { getServerTool, isServerTool, type ServerToolContext } from './registry.js';
import type { OpenAIToolCall } from '../../types.js';
import { Role } from '../../../lumo-client/types.js';
import type { MessageForStore } from 'src/conversations/types.js';

export interface ServerToolExecutionResult {
  /** Whether the tool name matched a registered ServerTool */
  isServerTool: boolean;
  /** Result string if execution succeeded */
  result?: string;
  /** Error message if execution failed */
  error?: string;
}

/**
 * Execute a ServerTool by name.
 *
 * @param toolName Tool name (without prefix)
 * @param args Arguments parsed from the tool call
 * @param context ServerTool context
 * @returns Execution result
 */
export async function executeServerTool(
  toolName: string,
  args: Record<string, unknown>,
  context: ServerToolContext
): Promise<ServerToolExecutionResult> {
  const tool = getServerTool(toolName);
  if (!tool) {
    return { isServerTool: false };
  }

  try {
    logger.info({ tool: toolName, args }, 'Executing ServerTool');
    const result = await tool.handler(args, context);
    logger.debug({ tool: toolName, resultLength: result.length }, 'ServerTool completed');
    return { isServerTool: true, result };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error({ error, tool: toolName }, 'ServerTool execution failed');
    return { isServerTool: true, error: errorMessage };
  }
}

// ── Partitioning ──────────────────────────────────────────────────────

export interface PartitionedToolCalls {
  serverToolCalls: OpenAIToolCall[];
  clientToolCalls: OpenAIToolCall[];
}

/**
 * Partition tool calls into ServerTools and CustomTools.
 * ServerTools are executed server-side, CustomTools are passed to API clients.
 */
export function partitionToolCalls(toolCalls: OpenAIToolCall[]): PartitionedToolCalls {
  const serverToolCalls: OpenAIToolCall[] = [];
  const clientToolCalls: OpenAIToolCall[] = [];

  for (const tc of toolCalls) {
    if (isServerTool(tc.function.name)) {
      serverToolCalls.push(tc);
    } else {
      clientToolCalls.push(tc);
    }
  }

  return { serverToolCalls, clientToolCalls };
}

// ── Continuation ──────────────────────────────────────────────────────

/**
 * Execute ServerTools and build continuation turns for the next Lumo call.
 *
 * Creates:
 * 1. An assistant turn with the iteration text (which includes tool call JSON)
 * 2. User turns with tool results for each executed ServerTool
 *
 * @param serverToolCalls - ServerTool calls to execute
 * @param assistantText - Text from the current iteration (includes tool call JSON)
 * @param context - ServerTool execution context
 * @param prefix - CustomTools prefix for tool result formatting
 * @returns MessageForStore[] ready to append for next Lumo call
 */
export async function buildServerToolContinuation(
  serverToolCalls: OpenAIToolCall[],
  assistantText: string,
  context: ServerToolContext,
  prefix: string
): Promise<MessageForStore[]> {
  const continuationTurns: MessageForStore[] = [];

  // Add assistant turn with the text (which includes tool call JSON)
  continuationTurns.push({
    role: Role.Assistant,
    content: assistantText,
  });

  // Execute each ServerTool and add result as user turn
  for (const tc of serverToolCalls) {
    const args = JSON.parse(tc.function.arguments);
    const execResult = await executeServerTool(tc.function.name, args, context);

    // Format result similar to CustomTool results
    const resultContent = execResult.error
      ? `Error executing ${tc.function.name}: ${execResult.error}`
      : execResult.result ?? 'No result';

    // Build user turn with tool result in JSON format (similar to function_call_output)
    const toolResultJson = JSON.stringify({
      type: 'function_call_output',
      call_id: tc.id,
      tool_name: `${prefix}${tc.function.name}`,
      output: resultContent,
    });

    continuationTurns.push({
      role: Role.User,
      content: `\`\`\`json\n${toolResultJson}\n\`\`\``,
      id: tc.id,
    });
  }

  return continuationTurns;
}
