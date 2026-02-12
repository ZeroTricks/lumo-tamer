import { Request, Response } from 'express';
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
import {
  buildRequestContext,
  persistTitle,
  persistAssistantTurn,
  extractToolsFromResponse,
  createStreamingToolProcessor,
  generateResponseId,
  generateItemId,
  generateFunctionCallId,
  generateCallId,
} from '../shared.js';

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

/** Tool call with generated call_id for persistence and response building. */
export interface ToolCallWithId {
  name: string;
  arguments: string;
  call_id: string;
}

/** Generate call_ids for tool calls. */
export function assignCallIds(toolCalls: Array<{ name: string; arguments: string }>): ToolCallWithId[] {
  return toolCalls.map(tc => ({
    name: tc.name,
    arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments),
    call_id: generateCallId(),
  }));
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
      const callId = 'call_id' in toolCall ? (toolCall as ToolCallWithId).call_id : generateCallId();

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
    instructions: request.instructions || null,
    max_output_tokens: request.max_output_tokens || null,
    model: request.model || getServerConfig().apiModelName,
    output,
    parallel_tool_calls: false,
    previous_response_id: null,
    reasoning: {
      effort: null,
      summary: null,
    },
    store: request.store || false,
    temperature: request.temperature || 1.0,
    text: {
      format: {
        type: 'text',
      },
    },
    tool_choice: 'none',
    tools: [],
    top_p: 1.0,
    truncation: 'auto',
    usage: null,
    user: null,
    metadata: request.metadata || {},
  };
}

// ── Handlers ───────────────────────────────────────────────────────

export async function handleStreamingRequest(
  req: Request,
  res: Response,
  deps: EndpointDependencies,
  request: OpenAIResponseRequest,
  turns: Turn[],
  conversationId: ConversationId | undefined
): Promise<void> {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  await deps.queue.add(async () => {
    const id = generateResponseId();
    const itemId = generateItemId();
    const createdAt = Math.floor(Date.now() / 1000);
    const model = request.model || getServerConfig().apiModelName;
    const emitter = new ResponseEventEmitter(res);
    let accumulatedText = '';
    // output_index 0 is the message item; tool calls start at 1
    let nextOutputIndex = 1;

    try {
      // Preamble events
      emitter.emitResponseCreated(id, createdAt, model);
      emitter.emitResponseInProgress(id, createdAt, model);
      emitter.emitOutputItemAdded(
        { id: itemId, type: 'message', role: 'assistant', status: 'in_progress', content: [] },
        0
      );
      emitter.emitContentPartAdded(itemId, 0, 0);

      const ctx = buildRequestContext(deps, conversationId, request.tools);
      logger.debug({ hasCustomTools: ctx.hasCustomTools, toolCount: request.tools?.length }, '[Server] Tool detector state');

      const processor = createStreamingToolProcessor(ctx.hasCustomTools, {
        emitTextDelta(text) {
          accumulatedText += text;
          emitter.emitOutputTextDelta(itemId, 0, 0, text);
        },
        emitToolCall(callId, tc) {
          emitter.emitFunctionCallEvents(id, callId, tc.name, JSON.stringify(tc.arguments), nextOutputIndex++);
        },
      });

      const result = await deps.lumoClient.chatWithHistory(
        turns,
        processor.onChunk,
        {
          commandContext: ctx.commandContext,
          requestTitle: ctx.requestTitle,
        }
      );

      logger.debug('[Server] Stream completed');
      processor.finalize();
      persistTitle(result, deps, conversationId);

      // Use stripped text for final events (tool JSON removed)
      if (processor.toolCallsEmitted.length > 0) {
        const { content } = extractToolsFromResponse(result.response, true);
        accumulatedText = content;
      } else {
        accumulatedText = result.response;
      }

      // Completion events
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

      // Convert emitted tool calls to format with call_id for persistence and output
      const toolCallsWithIds: ToolCallWithId[] = processor.toolCallsEmitted.map(tc => ({
        name: tc.function.name,
        arguments: tc.function.arguments,
        call_id: tc.id,
      }));

      const output = buildOutputItems({
        text: accumulatedText,
        itemId,
        toolCalls: toolCallsWithIds.length > 0 ? toolCallsWithIds : undefined,
      });

      // Persist response (with tool calls if any)
      persistAssistantTurn(
        deps, conversationId, accumulatedText,
        toolCallsWithIds.length > 0 ? toolCallsWithIds : undefined
      );
      emitter.emitResponseCompleted(createCompletedResponse(id, createdAt, request, output));
      res.end();
    } catch (error) {
      logger.error({ error: String(error) }, 'Streaming response error');
      emitter.emitError(error as Error);
      res.end();
    }
  });
}

export async function handleNonStreamingRequest(
  req: Request,
  res: Response,
  deps: EndpointDependencies,
  request: OpenAIResponseRequest,
  turns: Turn[],
  conversationId: ConversationId | undefined
): Promise<void> {
  const ctx = buildRequestContext(deps, conversationId, request.tools);

  const result = await deps.queue.add(async () =>
    deps.lumoClient.chatWithHistory(turns, undefined, {
      commandContext: ctx.commandContext,
      requestTitle: ctx.requestTitle,
    })
  );

  persistTitle(result, deps, conversationId);
  const { content, toolCalls } = extractToolsFromResponse(result.response, ctx.hasCustomTools);

  // Generate call_ids and persist (also registers call_ids for deduplication)
  const toolCallsWithIds = toolCalls.length > 0 ? assignCallIds(toolCalls) : undefined;
  persistAssistantTurn(deps, conversationId, content, toolCallsWithIds);

  const id = generateResponseId();
  const itemId = generateItemId();
  const createdAt = Math.floor(Date.now() / 1000);
  const output = buildOutputItems({
    text: content,
    itemId,
    toolCalls: toolCallsWithIds,
  });

  res.json(createCompletedResponse(id, createdAt, request, output));
}
