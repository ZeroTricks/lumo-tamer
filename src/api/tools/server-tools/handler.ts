/**
 * ServerTool Execution Loop
 *
 * Shared loop for both /v1/responses and /v1/chat/completions endpoints.
 * Handles ServerTool detection, execution, and continuation.
 */

import { logger } from '../../../app/logger.js';
import { getCustomToolPrefix } from '../../../app/config.js';
import { createStreamingToolProcessor, type StreamingToolEmitter } from '../streaming-processor.js';
import { isServerTool, type ServerToolContext } from './registry.js';
import { partitionToolCalls, executeServerTools, buildContinuationTurns, type ServerToolResult } from './executor.js';
import type { ChatMessageWithTools, EndpointDependencies, OpenAIToolCall } from '../../types.js';
import type { RequestContext } from 'src/api/types.js';
import type { Turn, ChatResult } from '../../../lumo-client/types.js';
import type { ConversationId, MessageForStore } from '../../../conversations/types.js';
import type { ParsedToolCall } from '../types.js';
import { convertToolMessage } from '../../message-converter.js';

// ── Types ─────────────────────────────────────────────────────────────

export interface ChatAndExecuteOptions {
  deps: EndpointDependencies;
  context: RequestContext;
  turns: Turn[];
  conversationId?: ConversationId;
  instructions?: string;
  injectInstructionsInto: 'first' | 'last';
  /** Callback for text deltas during streaming */
  onTextDelta: (text: string) => void;
  /** Callback for client tool calls (client must execute) */
  onClientToolCall: (callId: string, tc: ParsedToolCall) => void;
  /** Callback for server tool calls (informational, server executes) */
  onServerToolCall?: (tc: OpenAIToolCall) => void;
  /** Callback for server tool results (after execution) */
  onServerToolResult?: (result: ServerToolResult) => void;
}

export interface ChatAndExecuteResult {
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
export async function chatAndExecute(options: ChatAndExecuteOptions): Promise<ChatAndExecuteResult> {
  const { deps, context, instructions, injectInstructionsInto, onTextDelta, onClientToolCall } = options;
  const prefix = getCustomToolPrefix();

  let currentTurns = [...options.turns];
  let loopCount = 0;
  let accumulatedText = '';
  const allClientToolCalls: OpenAIToolCall[] = [];
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
          onClientToolCall(callId, tc);
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
    const { serverToolCalls, clientToolCalls } = partitionToolCalls(processor.toolCallsEmitted);
    allClientToolCalls.push(...clientToolCalls);

    // If no ServerTools, we're done
    if (serverToolCalls.length === 0) {
      logger.debug({ loopCount, clientToolCalls: clientToolCalls.length }, 'ServerTool loop complete (no ServerTools)');
      break;
    }

    logger.info({ loopCount, serverToolCount: serverToolCalls.length }, 'Executing ServerTools');

    // Emit server tool calls before execution
    for (const tc of serverToolCalls) {
      options.onServerToolCall?.(tc);
    }

    // Execute ServerTools and get results
    const results = await executeServerTools(serverToolCalls, serverToolCtx);

    // Emit server tool results after execution
    for (const result of results) {
      options.onServerToolResult?.(result);
    }

    // Build continuation turns for next Lumo call
    const continuationTurns = buildContinuationTurns(iterationText, results, prefix);

    // Update turns for next iteration
    currentTurns = [...currentTurns, ...continuationTurns];

    // Persist intermediate turns for stateful requests
    if (options.conversationId && deps.conversationStore) {

      // Persist title if generated
      if (chatResult.title) {
        deps.conversationStore.setTitle(options.conversationId, chatResult.title);
      }

      // First continuation turn is assistant with tool call JSON
      const assistantTurn = continuationTurns[0];
      if (assistantTurn.content)
        deps.conversationStore.appendAssistantResponse(
          options.conversationId,
          { content: assistantTurn.content }
        );
      const serverToolCallMessages = convertToolMessage({
        role: 'assistant',
        tool_calls: serverToolCalls,
      } as ChatMessageWithTools) as MessageForStore[];

      for (const serverToolCall of serverToolCallMessages) {
        deps.conversationStore.appendAssistantResponse(
          options.conversationId,
          { content: serverToolCall.content! },
          'succeeded',
          serverToolCall.id
        );
      }

      // Remaining turns are tool results
      const toolResultTurns = continuationTurns.slice(1);
      if (toolResultTurns.length > 0) {
        deps.conversationStore.appendMessages(
          options.conversationId,
          toolResultTurns,
          false
        );
      }

      logger.debug({ conversationId: options.conversationId, loopCount }, 'Persisted server tool iteration');
    }
  }

  if (loopCount >= MAX_SERVER_TOOL_LOOPS) {
    logger.warn({ maxLoops: MAX_SERVER_TOOL_LOOPS }, 'ServerTool loop reached maximum iterations');
  }

  // Persist final assistant message and title
  if (options.conversationId && deps.conversationStore) {
    // Skip if custom tools present (client will send back with results)
    if (allClientToolCalls.length === 0) {
      deps.conversationStore.appendAssistantResponse(
        options.conversationId,
        chatResult!.message
      );
    }

  }

  return {
    accumulatedText,
    customToolCalls: allClientToolCalls,
    chatResult: chatResult!,
  };
}
