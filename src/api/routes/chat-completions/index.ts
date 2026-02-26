import { Router, Request, Response } from 'express';
import { EndpointDependencies, OpenAIChatRequest, OpenAIChatResponse } from '../../types.js';
import { getServerConfig, getConversationsConfig, getLogConfig, getServerInstructionsConfig } from '../../../app/config.js';
import { logger } from '../../../app/logger.js';
import { convertChatMessages, extractSystemMessage } from '../../message-converter.js';
import { buildInstructions } from '../../instructions.js';
import { getMetrics } from '../../../app/metrics.js';
import { ChatCompletionEventEmitter } from './events.js';
import type { Turn } from '../../../lumo-client/index.js';
import type { ConversationId } from '../../../conversations/types.js';
import { trackCustomToolCompletion } from '../../tools/call-id.js';
import { createStreamingToolProcessor } from '../../tools/streaming-processor.js';
import {
  buildRequestContext,
  persistTitle,
  persistAssistantTurn,
  generateChatCompletionId,
  mapToolCallsForPersistence,
  tryExecuteCommand,
  setSSEHeaders,
} from '../shared.js';
import { sendInvalidRequest, sendServerError } from '../../error-handler.js';
import { deterministicUUID } from '../../../app/id-generator.js';

/** Extract tool_call_id from a role: 'tool' message. */
function extractToolCallId(msg: unknown): string | undefined {
  if (typeof msg !== 'object' || msg === null) return undefined;
  const obj = msg as Record<string, unknown>;
  if (obj.role === 'tool' && typeof obj.tool_call_id === 'string') return obj.tool_call_id;
  return undefined;
}

/**
 * Generate a deterministic conversation ID from the `user` field in the request.
 * Used for clients like Home Assistant that set `user` to their internal conversation_id.
 */
function generateConversationIdFromUser(user: string): ConversationId {
  return deterministicUUID(`user:${user}`);
}

export function createChatCompletionsRouter(deps: EndpointDependencies): Router {
  const router = Router();

  router.post('/v1/chat/completions', async (req: Request, res: Response) => {
    try {
      const request: OpenAIChatRequest = req.body;

      // Debug: log inbound message roles/content lengths to diagnose empty user content
      try {
        const debugMessages = Array.isArray(request.messages)
          ? request.messages.map((m, i) => {
              const content = typeof m.content === 'string' ? m.content : '';
              return {
                i,
                role: m.role,
                contentLength: content.length,
                preview: getLogConfig().messageContent ? content.slice(0, 120).replace(/\n/g, '\\n') : 'hidden',
              };
            })
          : [];
        logger.debug({
          model: request.model,
          stream: request.stream ?? false,
          messageCount: Array.isArray(request.messages) ? request.messages.length : 0,
          debugMessages,
        }, '[chat-completions] inbound request summary');
      } catch (debugError) {
        logger.warn({ error: String(debugError) }, '[chat-completions] failed to build inbound debug summary');
      }

      // Validate request
      if (!Array.isArray(request.messages) || request.messages.length === 0) {
        return sendInvalidRequest(res, 'messages must be a non-empty array', 'messages', 'missing_messages');
      }

      // Get the last user message
      const lastUserMessage = [...request.messages].reverse().find(m => m.role === 'user');
      if (!lastUserMessage) {
        return sendInvalidRequest(res, 'At least one user message is required', 'messages', 'missing_user_message');
      }

      // ===== Generate conversation ID for persistence =====
      // Chat Completions has no conversation parameter per OpenAI spec.
      // We use deriveIdFromUser to track conversations for Proton sync.
      // Without a deterministic ID, treat the request as stateless (no persistence).
      let conversationId: ConversationId | undefined;
      if (getConversationsConfig()?.deriveIdFromUser && request.user) {
        // Home Assistant sets `user` to its internal conversation_id, unique per chat session.
        conversationId = generateConversationIdFromUser(request.user);
      }
      // No else - leave undefined for stateless requests

      // ===== Track tool completions (all requests) =====
      // Set-based dedup in trackCustomToolCompletion prevents double-counting
      for (const msg of request.messages) {
        const callId = extractToolCallId(msg);
        if (callId) {
          trackCustomToolCompletion(callId);
        }
      }

      // ===== Convert messages to Lumo turns =====
      const turns = convertChatMessages(request.messages);

      // ===== Build instructions (injected in LumoClient, not persisted) =====
      const systemContent = extractSystemMessage(request.messages);
      const instructions = buildInstructions(request.tools, systemContent);
      const { injectInto } = getServerInstructionsConfig();

      // ===== Persist incoming messages (stateful only) =====
      if (conversationId && deps.conversationStore && turns.length > 0) {
        deps.conversationStore.appendMessages(conversationId, turns);
        logger.debug({ conversationId, messageCount: turns.length }, 'Persisted conversation messages');
      } else if (!conversationId) {
        // Stateless request - track +1 user message (not deduplicated)
        getMetrics()?.messagesTotal.inc({ role: 'user' });
      }

      // Add to queue and process
      await handleChatRequest(res, deps, request, turns, conversationId, request.stream ?? false, instructions, injectInto);
    } catch (error) {
      logger.error('Error processing chat completion:');
      logger.error(error);
      return sendServerError(res);
    }
  });

  return router;
}

async function handleChatRequest(
  res: Response,
  deps: EndpointDependencies,
  request: OpenAIChatRequest,
  turns: Turn[],
  conversationId: ConversationId | undefined,
  streaming: boolean,
  instructions: string | undefined,
  injectInstructionsInto: 'first' | 'last'
): Promise<void> {
  const id = generateChatCompletionId();
  const created = Math.floor(Date.now() / 1000);
  const model = request.model || getServerConfig().apiModelName;
  const ctx = buildRequestContext(deps, conversationId, request.tools);

  // Streaming setup
  const emitter = streaming ? new ChatCompletionEventEmitter(res, id, created, model) : null;
  if (emitter) {
    setSSEHeaders(res);
  }

  let accumulatedText = '';
  let toolCalls: typeof processor.toolCallsEmitted | undefined;

  const processor = createStreamingToolProcessor(ctx.hasCustomTools, {
    emitTextDelta(text) {
      accumulatedText += text;
      emitter?.emitContentDelta(text);
    },
    emitToolCall(callId, tc) {
      emitter?.emitToolCallDelta(callId, tc.name, tc.arguments);
    },
  });

  // Check for command before calling Lumo
  const commandResult = await tryExecuteCommand(turns, ctx.commandContext);
  if (commandResult) {
    accumulatedText = commandResult.response;
    emitter?.emitContentDelta(accumulatedText);
  } else {
    // Normal flow: call Lumo
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
      toolCalls = processor.toolCallsEmitted.length > 0 ? processor.toolCallsEmitted : undefined;

      persistAssistantTurn(
        deps,
        conversationId,
        result.message,
        mapToolCallsForPersistence(processor.toolCallsEmitted)
      );
    } catch (error) {
      logger.error({ error: String(error) }, 'Chat completion error');
      if (emitter) {
        emitter.emitError(error as Error);
      } else {
        sendServerError(res);
      }
      return;
    }
  }

  // Build and send response (shared for both command and normal flow)
  try {
    if (emitter) {
      emitter.emitDone(toolCalls);
    } else {
      const response: OpenAIChatResponse = {
        id,
        object: 'chat.completion',
        created,
        model,
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: accumulatedText,
            ...(toolCalls ? { tool_calls: toolCalls } : {}),
          },
          finish_reason: toolCalls ? 'tool_calls' : 'stop',
        }],
      };
      res.json(response);
    }
  } catch (error) {
    logger.error({ error: String(error) }, 'Error sending chat completion response');
    if (emitter) {
      emitter.emitError(error as Error);
    } else {
      sendServerError(res);
    }
  }
}
