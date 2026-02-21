import { Response } from 'express';
import {
  EndpointDependencies,
  OpenAIResponseRequest,
  OpenAIResponse,
  OutputItem,
  MessageOutputItem,
  FunctionCallOutputItem,
} from '../../types.js';
import { getServerConfig } from '../../../app/config.js';
import { logger } from '../../../app/logger.js';
import { ResponseEventEmitter } from './events.js';
import type { Turn } from '../../../lumo-client/index.js';
import type { ConversationId } from '../../../conversations/index.js';
import { generateCallId } from '../../tools/call-id.js';
import { createStreamingToolProcessor } from '../../tools/streaming-processor.js';
import {
  buildRequestContext,
  persistTitle,
  persistAssistantTurn,
  generateResponseId,
  generateItemId,
  generateFunctionCallId,
  mapToolCallsForPersistence,
  tryExecuteCommand,
  setSSEHeaders,
  type ToolCallForPersistence,
} from '../shared.js';
import { sendServerError } from '../../error-handler.js';

// ── Output building ────────────────────────────────────────────────

interface ToolCall {
  name: string;
  arguments: string | object;
}

interface BuildOutputOptions {
  text: string;
  toolCalls?: ToolCall[] | null;
  itemId?: string;
}

function buildOutputItems(options: BuildOutputOptions): OutputItem[] {
  const { text, toolCalls, itemId } = options;

  const messageItem: MessageOutputItem = {
    type: 'message',
    id: itemId || generateItemId(),
    status: 'completed',
    role: 'assistant',
    content: [
      {
        type: 'output_text',
        text,
        annotations: [],
      },
    ],
  };

  const output: OutputItem[] = [messageItem];

  if (toolCalls && toolCalls.length > 0) {
    for (const toolCall of toolCalls) {
      const argumentsJson = typeof toolCall.arguments === 'string'
        ? toolCall.arguments
        : JSON.stringify(toolCall.arguments);

      // Use pre-generated call_id if available, otherwise generate new one
      const callId = 'call_id' in toolCall ? (toolCall as ToolCallForPersistence).call_id : generateCallId(toolCall.name);

      output.push({
        type: 'function_call',
        id: generateFunctionCallId(),
        call_id: callId,
        status: 'completed',
        name: toolCall.name,
        arguments: argumentsJson,
      } satisfies FunctionCallOutputItem);
    }
  }

  return output;
}

// ── Response factory ───────────────────────────────────────────────

function createCompletedResponse(
  responseId: string,
  createdAt: number,
  request: OpenAIResponseRequest,
  output: OutputItem[]
): OpenAIResponse {
  return {
    id: responseId,
    object: 'response',
    created_at: createdAt,
    status: 'completed',
    completed_at: Math.floor(Date.now() / 1000),
    error: null,
    incomplete_details: null,
    instructions: request.instructions ?? null,
    max_output_tokens: request.max_output_tokens ?? request.max_tokens ?? null,
    model: request.model || getServerConfig().apiModelName,
    output,
    parallel_tool_calls: false,
    previous_response_id: request.previous_response_id ?? null,
    reasoning: {
      effort: null,
      summary: null,
    },
    store: request.store ?? false,
    temperature: request.temperature ?? 1.0,
    text: {
      format: {
        type: 'text',
      },
    },
    tool_choice: request.tools && request.tools.length > 0 ? 'auto' : 'none',
    tools: request.tools ?? [],
    top_p: 1.0,
    truncation: 'auto',
    usage: null,
    user: request.user ?? null,
    metadata: request.metadata || {},
  };
}

// ── Unified handler ────────────────────────────────────────────────

export async function handleRequest(
  res: Response,
  deps: EndpointDependencies,
  request: OpenAIResponseRequest,
  turns: Turn[],
  conversationId: ConversationId | undefined,
  streaming: boolean,
  instructions: string | undefined,
  injectInstructionsInto: 'first' | 'last'
): Promise<void> {
  const id = generateResponseId();
  const itemId = generateItemId();
  const createdAt = Math.floor(Date.now() / 1000);
  const model = request.model || getServerConfig().apiModelName;
  const ctx = buildRequestContext(deps, conversationId, request.tools);

  // Streaming setup
  const emitter = streaming ? new ResponseEventEmitter(res) : null;
  if (emitter) {
    setSSEHeaders(res);
    emitter.emitResponseCreated(id, createdAt, model);
    emitter.emitResponseInProgress(id, createdAt, model);
    emitter.emitOutputItemAdded(
      { id: itemId, type: 'message', role: 'assistant', status: 'in_progress', content: [] },
      0
    );
    emitter.emitContentPartAdded(itemId, 0, 0);
  }

  logger.debug({ hasCustomTools: ctx.hasCustomTools, toolCount: request.tools?.length }, '[Server] Tool detector state');

  let accumulatedText = '';
  let toolCallsForPersist: ToolCallForPersistence[] | undefined;

  // Check for command before calling Lumo
  const commandResult = await tryExecuteCommand(turns, ctx.commandContext);
  if (commandResult) {
    accumulatedText = commandResult.response;
    emitter?.emitOutputTextDelta(itemId, 0, 0, accumulatedText);
  } else {
    // Normal flow: call Lumo
    let nextOutputIndex = 1;
    const processor = createStreamingToolProcessor(ctx.hasCustomTools, {
      emitTextDelta(text) {
        accumulatedText += text;
        emitter?.emitOutputTextDelta(itemId, 0, 0, text);
      },
      emitToolCall(callId, tc) {
        emitter?.emitFunctionCallEvents(id, callId, tc.name, JSON.stringify(tc.arguments), nextOutputIndex++);
      },
    });

    try {
      const result = await deps.queue.add(async () =>
        deps.lumoClient.chatWithHistory(turns, processor.onChunk, {
          requestTitle: ctx.requestTitle,
          instructions,
          injectInstructionsInto,
        })
      );

      logger.debug('[Server] Stream completed');
      processor.finalize();
      persistTitle(result, deps, conversationId);
      toolCallsForPersist = mapToolCallsForPersistence(processor.toolCallsEmitted);

      persistAssistantTurn(deps, conversationId, result.message, toolCallsForPersist);
    } catch (error) {
      logger.error({ error: String(error) }, 'Response error');
      if (emitter) {
        emitter.emitError(error as Error);
        res.end();
      } else {
        sendServerError(res);
      }
      return;
    }
  }

  // Build and send response (shared for both command and normal flow)
  try {
    const output = buildOutputItems({ text: accumulatedText, itemId, toolCalls: toolCallsForPersist });
    const response = createCompletedResponse(id, createdAt, request, output);

    if (emitter) {
      emitter.emitOutputTextDone(itemId, 0, 0, accumulatedText);
      emitter.emitContentPartDone(itemId, 0, 0, accumulatedText);
      emitter.emitOutputItemDone(
        {
          id: itemId,
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: accumulatedText, annotations: [] }],
        },
        0
      );
      emitter.emitResponseCompleted(response);
      res.end();
    } else {
      res.json(response);
    }
  } catch (error) {
    logger.error({ error: String(error) }, 'Error sending response');
    if (emitter) {
      emitter.emitError(error as Error);
      res.end();
    } else {
      sendServerError(res);
    }
  }
}
