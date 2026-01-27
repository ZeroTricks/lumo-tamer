import { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { EndpointDependencies, OpenAIResponseRequest, OpenAIToolCall } from '../../types.js';
import { getServerConfig, getToolsConfig } from '../../../app/config.js';
import { logger } from '../../../app/logger.js';
import { ResponseEventEmitter } from './events.js';
import { buildOutputItems } from './output-builder.js';
import { createCompletedResponse } from './response-factory.js';
import type { Turn } from '../../../lumo-client/index.js';
import type { ConversationId } from '../../../conversations/index.js';
import { StreamingToolDetector } from 'api/streaming-tool-detector.js';
import type { CommandContext } from '../../../app/commands.js';
import { postProcessTitle } from '../../../proton-shims/lumo-api-client-utils.js';

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
    const client = deps.lumoClient;

    try {
      // Event 1: response.created
      emitter.emitResponseCreated(id, createdAt, request.model || getServerConfig().apiModelName);

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
      const enableExternalTools = getToolsConfig()?.enableWebSearch ?? false;

      // Check if request has custom tools AND tools are enabled
      const hasCustomTools = getToolsConfig().enabled && request.tools && request.tools.length > 0;

      // Create detector if custom tools are enabled
      const detector = hasCustomTools ? new StreamingToolDetector() : null;
      const toolCallsEmitted: OpenAIToolCall[] = [];
      let toolCallIndex = 0;


      // Build command context for /save and other commands
      const commandContext: CommandContext = {
        syncInitialized: deps.syncInitialized ?? false,
        conversationId,
        authManager: deps.authManager,
        tokenCachePath: deps.tokenCachePath,
      };

      // Request title for new conversations (title still has default value)
      const existingConv = deps.conversationStore?.get(conversationId);
      const requestTitle = existingConv?.title === 'New Conversation';

      // Get response using LumoClient
      const result = await client.chatWithHistory(
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
              deps.conversationStore?.addGeneratedCallId(conversationId, callId);
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

        { enableEncryption: true, enableExternalTools, commandContext, requestTitle }
      );

      logger.debug('[Server] Stream completed');

      if(detector){
        emitter.emitOutputTextDelta(itemId, 0, 0, detector.getPendingText());
      }

      // Save generated title if present
      if (result.title && deps.conversationStore) {
        const processedTitle = postProcessTitle(result.title);
        deps.conversationStore.setTitle(conversationId, processedTitle);
      }

      // Update accumulated text from result (in case of discrepancy)
      accumulatedText = result.response;

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
  const enableExternalTools = getToolsConfig()?.enableWebSearch ?? false;

  // Build command context for /save and other commands
  const commandContext: CommandContext = {
    syncInitialized: deps.syncInitialized ?? false,
    conversationId,
    authManager: deps.authManager,
    tokenCachePath: deps.tokenCachePath,
  };

  // Request title for new conversations (title still has default value)
  const existingConv = deps.conversationStore?.get(conversationId);
  const requestTitle = existingConv?.title === 'New Conversation';

  // Non-streaming response
  const result = await deps.queue.add(async () => {
    const client = deps.lumoClient;
    return await client.chatWithHistory(
      turns,
      undefined,
      { enableEncryption: true, enableExternalTools, commandContext, requestTitle }
    );
  });

  const id = `resp-${randomUUID()}`;
  const itemId = `item-${randomUUID()}`;
  const createdAt = Math.floor(Date.now() / 1000);

  // Save generated title if present
  if (result.title && deps.conversationStore) {
    const processedTitle = postProcessTitle(result.title);
    deps.conversationStore.setTitle(conversationId, processedTitle);
  }

  // TODO: call tools

  // Build output array with message item only (no tool calls)
  const output = buildOutputItems({
    text: result.response,
    itemId,
  });

  // Persist assistant response if conversation store is available
  if (deps.conversationStore) {
    deps.conversationStore.appendAssistantResponse(conversationId, result.response);
    logger.debug({ conversationId }, 'Persisted assistant response');
  }

  const response = createCompletedResponse(id, createdAt, request, output);

  res.json(response);
}
