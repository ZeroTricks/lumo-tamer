import { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { EndpointDependencies, OpenAIResponseRequest } from '../../types.js';
import { getServerConfig } from '../../../app/config.js';
import { logger } from '../../../app/logger.js';
import { ResponseEventEmitter } from './events.js';
import { buildOutputItems } from './output-builder.js';
import { createCompletedResponse } from './response-factory.js';
import type { Turn } from '../../../lumo-client/index.js';
import type { ConversationId } from '../../../conversations/index.js';
import {
  buildRequestContext,
  persistTitle,
  persistResponse,
  extractToolsFromResponse,
  createStreamingToolProcessor,
} from '../shared.js';

export async function handleStreamingRequest(
  req: Request,
  res: Response,
  deps: EndpointDependencies,
  request: OpenAIResponseRequest,
  turns: Turn[],
  conversationId: ConversationId
): Promise<void> {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  await deps.queue.add(async () => {
    const id = `resp-${randomUUID()}`;
    const itemId = `item-${randomUUID()}`;
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
          // Track call ID per-conversation for function output deduplication
          deps.conversationStore?.addGeneratedCallId(conversationId, callId);
          emitter.emitFunctionCallEvents(id, callId, tc.name, JSON.stringify(tc.arguments), nextOutputIndex++);
        },
      });

      const result = await deps.lumoClient.chatWithHistory(
        turns,
        processor.onChunk,
        {
          enableEncryption: true,
          enableExternalTools: ctx.enableExternalTools,
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

      const output = buildOutputItems({
        text: accumulatedText,
        itemId,
        toolCalls: processor.toolCallsEmitted.length > 0
          ? processor.toolCallsEmitted.map(tc => ({ name: tc.function.name, arguments: tc.function.arguments }))
          : undefined,
      });

      persistResponse(deps, conversationId, accumulatedText);
      emitter.emitResponseCompleted(createCompletedResponse(id, createdAt, request, output));
      res.end();
    } catch (error) {
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
  conversationId: ConversationId
): Promise<void> {
  const ctx = buildRequestContext(deps, conversationId, request.tools);

  const result = await deps.queue.add(async () =>
    deps.lumoClient.chatWithHistory(turns, undefined, {
      enableEncryption: true,
      enableExternalTools: ctx.enableExternalTools,
      commandContext: ctx.commandContext,
      requestTitle: ctx.requestTitle,
    })
  );

  persistTitle(result, deps, conversationId);
  const { content, toolCalls } = extractToolsFromResponse(result.response, ctx.hasCustomTools);
  persistResponse(deps, conversationId, content);

  const id = `resp-${randomUUID()}`;
  const itemId = `item-${randomUUID()}`;
  const createdAt = Math.floor(Date.now() / 1000);
  const output = buildOutputItems({
    text: content,
    itemId,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
  });

  res.json(createCompletedResponse(id, createdAt, request, output));
}
