import { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { EndpointDependencies, OpenAIResponseRequest, OpenAIToolCall } from '../../types.js';
import { serverConfig, toolsConfig } from '../../../app/config.js';
import { logger } from '../../../app/logger.js';
import { ResponseEventEmitter } from './events.js';
import { buildOutputItems } from './output-builder.js';
import { createCompletedResponse } from './response-factory.js';
import type { Turn } from '../../../lumo-client/index.js';
import type { ConversationId } from '../../../persistence/index.js';
import { StreamingToolDetector } from 'api/streaming-tool-detector.js';
import type { CommandContext } from '../../../app/commands.js';

export async function handleStreamingRequest(
  req: Request,
  res: Response,
  deps: EndpointDependencies,
  request: OpenAIResponseRequest,
  turns: Turn[],
  conversationId: ConversationId
): Promise<void> {
  // Streaming response with event-based format
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  await deps.queue.add(async () => {
    const id = `resp-${randomUUID()}`;
    const itemId = `item-${randomUUID()}`;
    const createdAt = Math.floor(Date.now() / 1000);
    let accumulatedText = '';

    const emitter = new ResponseEventEmitter(res);
    const client = deps.getLumoClient();

    try {
      // Event 1: response.created
      emitter.emitResponseCreated(id, createdAt, request.model || serverConfig.apiModelName);

      // Event 2: response.in_progress
      emitter.emitResponseInProgress(id, createdAt);

      // Event 3: response.output_item.added
      emitter.emitOutputItemAdded(
        {
          id: itemId,
          type: 'message',
          role: 'assistant',
          status: 'in_progress',
          content: [],
        },
        0
      );

      // Event 4: response.content_part.added
      emitter.emitContentPartAdded(itemId, 0, 0);

      // Determine if external tools (web_search, etc.) should be enabled
      const enableExternalTools = toolsConfig?.enableWebSearch ?? false;

      // Check if request has custom tools (legacy mode)
      const hasCustomTools = request.tools && request.tools.length > 0;

      // Create detector if custom tools are provided
      const detector = hasCustomTools ? new StreamingToolDetector() : null;
      const toolCallsEmitted: OpenAIToolCall[] = [];
      let toolCallIndex = 0;


      // Build command context for /save and other commands
      const commandContext: CommandContext = {
        syncInitialized: deps.syncInitialized ?? false,
      };

      // Get response using SimpleLumoClient
      const responseText = await client.chatWithHistory(
        turns,
        (chunk: string) => {
          if (detector) {
            // Use streaming tool detector
            const { textToEmit, completedToolCalls } = detector.processChunk(chunk);

            accumulatedText += textToEmit;

            // Emit text delta if any
            // emitContentDelta(textToEmit);
            emitter.emitOutputTextDelta(itemId, 0, 0, textToEmit);

            let i = 0;
            // Emit tool call deltas for completed tools
            for (const tc of completedToolCalls) {
              const callId = `call_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
              // Track call ID per-conversation for function output deduplication
              deps.conversationStore?.addCreatedCallId(conversationId, callId);
              toolCallsEmitted.push({
                id: callId,
                type: 'function',
                function: {
                  name: tc.name,
                  arguments: JSON.stringify(tc.arguments),
                },
              });

              // emitToolCallDelta(toolCallIndex++, callId, tc.name, tc.arguments);
              emitter.emitFunctionCallEvents(id, callId, tc.name, JSON.stringify(tc.arguments), i++);
              logger.debug({ name: tc.name }, '[Server] Tool call emitted in stream');
            }
          } else {
            // No tools - pass through directly
            emitter.emitOutputTextDelta(itemId, 0, 0, chunk);
          }
        },

        { enableEncryption: true, enableExternalTools, commandContext }
      );

      logger.debug('[Server] Stream completed');

      if(detector){
        emitter.emitOutputTextDelta(itemId, 0, 0, detector.getPendingText());
      }

      // Update accumulated text from result (in case of discrepancy)
      accumulatedText = responseText;

      // Event N-4: response.output_text.done
      emitter.emitOutputTextDone(itemId, 0, 0, accumulatedText);

      // Build output array with message item only (no tool calls)
      const output = buildOutputItems({
        text: accumulatedText,
        itemId,
      });

      // Persist assistant response if conversation store is available
      if (deps.conversationStore) {
        deps.conversationStore.appendAssistantResponse(conversationId, accumulatedText);
        logger.debug({ conversationId }, 'Persisted assistant response');
      }

      // Event N-1: response.completed
      const completedResponse = createCompletedResponse(id, createdAt, request, output);
      emitter.emitResponseCompleted(completedResponse);

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
  // Determine if external tools (web_search, etc.) should be enabled
  const enableExternalTools = toolsConfig?.enableWebSearch ?? false;

  // Build command context for /save and other commands
  const commandContext: CommandContext = {
    syncInitialized: deps.syncInitialized ?? false,
  };

  // Non-streaming response
  const responseText = await deps.queue.add(async () => {
    const client = deps.getLumoClient();
    return await client.chatWithHistory(
      turns,
      undefined,
      { enableEncryption: true, enableExternalTools, commandContext }
    );
  });

  const id = `resp-${randomUUID()}`;
  const itemId = `item-${randomUUID()}`;
  const createdAt = Math.floor(Date.now() / 1000);

  // TODO: call tools

  // Build output array with message item only (no tool calls)
  const output = buildOutputItems({
    text: responseText,
    itemId,
  });

  // Persist assistant response if conversation store is available
  if (deps.conversationStore) {
    deps.conversationStore.appendAssistantResponse(conversationId, responseText);
    logger.debug({ conversationId }, 'Persisted assistant response');
  }

  const response = createCompletedResponse(id, createdAt, request, output);

  res.json(response);
}
