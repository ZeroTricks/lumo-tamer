/**
 * ServerTool Execution Loop
 *
 * Shared loop for both /v1/responses and /v1/chat/completions endpoints.
 * Handles ServerTool detection, execution, and continuation.
 */

import { logger } from '../../../app/logger.js';
import { getCustomToolsConfig } from '../../../app/config.js';
import { createStreamingToolProcessor, type StreamingToolEmitter } from '../streaming-processor.js';
import { isServerTool, type ServerToolContext } from './registry.js';
import { partitionToolCalls, buildServerToolContinuation } from './executor.js';
import type { EndpointDependencies, OpenAIToolCall } from '../../types.js';
import type { RequestContext } from '../../routes/shared.js';
import type { Turn, ChatResult } from '../../../lumo-client/types.js';
import type { ConversationId } from '../../../conversations/types.js';
import type { ParsedToolCall } from '../types.js';

// ── Types ─────────────────────────────────────────────────────────────

export interface ServerToolLoopOptions {
  deps: EndpointDependencies;
  context: RequestContext;
  turns: Turn[];
  conversationId?: ConversationId;
  instructions?: string;
  injectInstructionsInto: 'first' | 'last';
  /** Callback for text deltas during streaming */
  onTextDelta: (text: string) => void;
  /** Callback for tool calls (only CustomTools, ServerTools filtered out) */
  onToolCall: (callId: string, tc: ParsedToolCall) => void;
}

export interface ServerToolLoopResult {
  /** Accumulated text from all iterations */
  accumulatedText: string;
  /** CustomTool calls only (ServerTool calls filtered out) */
  customToolCalls: OpenAIToolCall[];
  /** Final chat result from last Lumo call */
  chatResult: ChatResult;
}

const MAX_SERVER_TOOL_LOOPS = 5;

// ── Loop implementation ───────────────────────────────────────────────

/**
 * Run the ServerTool execution loop.
 *
 * This function:
 * 1. Calls Lumo with streaming processor
 * 2. Detects ServerTool calls in the response
 * 3. Executes ServerTools server-side
 * 4. Loops back to Lumo with results (up to MAX_SERVER_TOOL_LOOPS times)
 * 5. Returns final text and any CustomTool calls
 */
export async function runServerToolLoop(options: ServerToolLoopOptions): Promise<ServerToolLoopResult> {
  const { deps, context, instructions, injectInstructionsInto, onTextDelta, onToolCall } = options;
  const { prefix } = getCustomToolsConfig();

  let currentTurns = [...options.turns];
  let loopCount = 0;
  let accumulatedText = '';
  const allCustomToolCalls: OpenAIToolCall[] = [];
  let chatResult: ChatResult | undefined;

  // Build ServerTool context
  const serverToolCtx: ServerToolContext = {
    conversationStore: deps.conversationStore,
    conversationId: options.conversationId,
  };

  while (loopCount < MAX_SERVER_TOOL_LOOPS) {
    loopCount++;
    logger.debug({ loopCount }, 'ServerTool loop iteration');

    // Track text for this iteration
    let iterationText = '';

    // Create emitter that wraps the original callbacks
    const emitter: StreamingToolEmitter = {
      emitTextDelta(text) {
        iterationText += text;
        accumulatedText += text;
        onTextDelta(text);
      },
      emitToolCall(callId, tc) {
        // Only emit CustomTool calls to the client
        if (!isServerTool(tc.name)) {
          onToolCall(callId, tc);
        }
      },
    };

    // Create streaming processor
    const processor = createStreamingToolProcessor(context.hasCustomTools, emitter);

    // Call Lumo
    const result = await deps.queue.add(async () =>
      deps.lumoClient.chatWithHistory(currentTurns, processor.onChunk, {
        requestTitle: context.requestTitle,
        instructions,
        injectInstructionsInto,
      })
    );

    processor.finalize();
    chatResult = result;

    // Partition tool calls into ServerTools and CustomTools
    const { serverToolCalls, customToolCalls } = partitionToolCalls(processor.toolCallsEmitted);
    allCustomToolCalls.push(...customToolCalls);

    // If no ServerTools, we're done
    if (serverToolCalls.length === 0) {
      logger.debug({ loopCount, customToolCalls: customToolCalls.length }, 'ServerTool loop complete (no ServerTools)');
      break;
    }

    logger.info({ loopCount, serverToolCount: serverToolCalls.length }, 'Executing ServerTools');

    // Execute ServerTools and build continuation turns
    const continuationTurns = await buildServerToolContinuation(
      serverToolCalls,
      iterationText,
      serverToolCtx,
      prefix
    );

    // Update turns for next iteration
    currentTurns = [...currentTurns, ...continuationTurns];
  }

  if (loopCount >= MAX_SERVER_TOOL_LOOPS) {
    logger.warn({ maxLoops: MAX_SERVER_TOOL_LOOPS }, 'ServerTool loop reached maximum iterations');
  }

  return {
    accumulatedText,
    customToolCalls: allCustomToolCalls,
    chatResult: chatResult!,
  };
}
