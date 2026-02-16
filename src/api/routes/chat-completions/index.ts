import { Router, Request, Response } from 'express';
import { randomUUID, createHash } from 'crypto';
import { EndpointDependencies, OpenAIChatRequest, OpenAIChatResponse } from '../../types.js';
import { getServerConfig, getConversationsConfig, getLogConfig } from '../../../app/config.js';
import { logger } from '../../../app/logger.js';
import { convertMessagesToTurns, normalizeInputItem } from '../../message-converter.js';
import { getMetrics } from '../../metrics/index.js';
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
} from '../shared.js';
import { sendInvalidRequest, sendServerError } from '../../openai-error.js';

// Session ID generated once at module load - makes deterministic IDs unique per server session
const SESSION_ID = randomUUID();

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
  const hash = createHash('sha256').update(`lumo-tamer:${SESSION_ID}:user:${user}`).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
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

      // ===== Convert messages to Lumo turns (includes system message injection) =====
      // Pass tools to enable legacy tool instruction injection
      const turns = convertMessagesToTurns(request.messages, request.tools);

      // ===== Persist incoming messages (stateful only) =====
      if (conversationId && deps.conversationStore) {
        const allMessages: Array<{ role: string; content: string }> = [];
        for (const msg of request.messages) {
          // Use normalizeInputItem for tool-related messages (role: 'tool', tool_calls)
          const normalized = normalizeInputItem(msg);
          if (normalized) {
            const normalizedArray = Array.isArray(normalized) ? normalized : [normalized];
            allMessages.push(...normalizedArray);
          } else {
            // Regular message - ensure content is a string
            allMessages.push({
              role: msg.role,
              content: typeof msg.content === 'string' ? msg.content : '',
            });
          }
        }
        deps.conversationStore.appendMessages(conversationId, allMessages);
        logger.debug({ conversationId, messageCount: allMessages.length }, 'Persisted conversation messages');
      } else {
        // Stateless request - track +1 user message (not deduplicated)
        getMetrics()?.messagesTotal.inc({ role: 'user' });
      }

      // Add to queue and process
      await handleChatRequest(res, deps, request, turns, conversationId, request.stream ?? false);
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
  streaming: boolean
): Promise<void> {
  const id = generateChatCompletionId();
  const created = Math.floor(Date.now() / 1000);
  const model = request.model || getServerConfig().apiModelName;
  const ctx = buildRequestContext(deps, conversationId, request.tools);

  // Streaming setup
  const emitter = streaming ? new ChatCompletionEventEmitter(res, id, created, model) : null;
  if (emitter) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
  }

  let accumulatedText = '';

  const processor = createStreamingToolProcessor(ctx.hasCustomTools, {
    emitTextDelta(text) {
      accumulatedText += text;
      emitter?.emitContentDelta(text);
    },
    emitToolCall(callId, tc) {
      emitter?.emitToolCallDelta(callId, tc.name, tc.arguments);
    },
  });

  try {
    const result = await deps.queue.add(async () =>
      deps.lumoClient.chatWithHistory(turns, processor.onChunk, {
        commandContext: ctx.commandContext,
        requestTitle: ctx.requestTitle,
      })
    );

    logger.debug('[Server] Stream completed');
    processor.finalize();
    persistTitle(result, deps, conversationId);

    const toolCalls = processor.toolCallsEmitted.length > 0 ? processor.toolCallsEmitted : undefined;
    persistAssistantTurn(deps, conversationId, accumulatedText, mapToolCallsForPersistence(processor.toolCallsEmitted));

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
    logger.error({ error: String(error) }, 'Chat completion error');
    if (emitter) {
      emitter.emitError(error as Error);
    } else {
      sendServerError(res);
    }
  }
}
