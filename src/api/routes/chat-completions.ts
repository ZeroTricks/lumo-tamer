import { Router, Request, Response } from 'express';
import { randomUUID, createHash } from 'crypto';
import { EndpointDependencies, OpenAIChatRequest, OpenAIStreamChunk, OpenAIChatResponse, OpenAIToolCall } from '../types.js';
import { getServerConfig, getConversationsConfig } from '../../app/config.js';
import { logger } from '../../app/logger.js';
import { convertMessagesToTurns } from '../message-converter.js';
import type { Turn } from '../../lumo-client/index.js';
import type { ConversationId } from '../../conversations/index.js';
import {
  buildRequestContext,
  persistTitle,
  persistResponse,
  extractToolsFromResponse,
  generateCallId,
  createStreamingToolProcessor,
} from './shared.js';

// Session ID generated once at module load - makes deterministic IDs unique per server session
const SESSION_ID = randomUUID();

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

      // Validate request
      if (!request.messages || request.messages.length === 0) {
        return res.status(400).json({ error: 'Messages array is required' });
      }

      // Get the last user message
      const lastUserMessage = [...request.messages].reverse().find(m => m.role === 'user');
      if (!lastUserMessage) {
        return res.status(400).json({ error: 'No user message found' });
      }

      // ===== Generate conversation ID for persistence =====
      // Chat Completions has no conversation parameter per OpenAI spec.
      // We use deriveIdFromUser to track conversations for Proton sync.
      let conversationId: ConversationId;
      if (getConversationsConfig()?.deriveIdFromUser && request.user) {
        // Home Assistant sets `user` to its internal conversation_id, unique per chat session.
        conversationId = generateConversationIdFromUser(request.user);
      } else {
        // Random UUID per request (creates separate conversations)
        conversationId = randomUUID();
      }

      // ===== Persist incoming messages (with deduplication) =====
      if (deps.conversationStore) {
        const allMessages = request.messages.map(m => ({
          role: m.role,
          content: m.content
        }));
        deps.conversationStore.appendMessages(conversationId, allMessages);
        logger.debug({ conversationId, messageCount: allMessages.length }, 'Persisted conversation messages');
      }

      // Convert messages to Lumo turns (includes system message injection)
      // Pass tools to enable legacy tool instruction injection
      const turns = convertMessagesToTurns(request.messages, request.tools);

      // Add to queue and process
      if (request.stream) {
        await handleStreamingRequest(res, deps, request, turns, conversationId);
      } else {
        await handleNonStreamingRequest(res, deps, request, turns, conversationId);
      }
    } catch (error) {
      logger.error('Error processing chat completion:');
      logger.error(error);
      res.status(500).json({ error: String(error) });
    }
  });

  return router;
}

function handleCommandStreamingResponse(
  res: Response,
  request: OpenAIChatRequest,
  text: string
): void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);

  // Send the text as a single chunk
  const chunk: OpenAIStreamChunk = {
    id,
    object: 'chat.completion.chunk',
    created,
    model: request.model || getServerConfig().apiModelName,
    choices: [
      {
        index: 0,
        delta: { content: text },
        finish_reason: null,
      },
    ],
  };
  res.write(`data: ${JSON.stringify(chunk)}\n\n`);

  // Send final chunk
  const finalChunk: OpenAIStreamChunk = {
    id,
    object: 'chat.completion.chunk',
    created,
    model: request.model || getServerConfig().apiModelName,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: 'stop',
      },
    ],
  };
  res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

function handleCommandNonStreamingResponse(
  res: Response,
  request: OpenAIChatRequest,
  text: string
): void {
  const response: OpenAIChatResponse = {
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: request.model || getServerConfig().apiModelName,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: text,
        },
        finish_reason: 'stop',
      },
    ],
  };
  res.json(response);
}

async function handleStreamingRequest(
  res: Response,
  deps: EndpointDependencies,
  request: OpenAIChatRequest,
  turns: Turn[],
  conversationId: ConversationId
): Promise<void> {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  await deps.queue.add(async () => {
    const id = `chatcmpl-${randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);
    let toolCallIndex = 0;

    // Helper to emit content delta chunk
    const emitContentDelta = (content: string) => {
      if (!content) return;
      const sseChunk: OpenAIStreamChunk = {
        id,
        object: 'chat.completion.chunk',
        created,
        model: request.model || getServerConfig().apiModelName,
        choices: [
          {
            index: 0,
            delta: { content },
            finish_reason: null,
          },
        ],
      };
      res.write(`data: ${JSON.stringify(sseChunk)}\n\n`);
    };

    // Helper to emit tool call delta chunk (complete tool call in one chunk)
    const emitToolCallDelta = (index: number, callId: string, name: string, args: Record<string, unknown>) => {
      const sseChunk: OpenAIStreamChunk = {
        id,
        object: 'chat.completion.chunk',
        created,
        model: request.model || getServerConfig().apiModelName,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index,
                  id: callId,
                  type: 'function',
                  function: {
                    name,
                    arguments: JSON.stringify(args),
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      };
      res.write(`data: ${JSON.stringify(sseChunk)}\n\n`);
    };

    try {
      const ctx = buildRequestContext(deps, conversationId, request.tools);

      const processor = createStreamingToolProcessor(ctx.hasCustomTools, {
        emitTextDelta(text) { emitContentDelta(text); },
        emitToolCall(callId, tc) {
          emitToolCallDelta(toolCallIndex++, callId, tc.name, tc.arguments);
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
      persistResponse(deps, conversationId, result.response);

      // Send final chunk with finish_reason
      const finalChunk: OpenAIStreamChunk = {
        id,
        object: 'chat.completion.chunk',
        created,
        model: request.model || getServerConfig().apiModelName,
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: processor.toolCallsEmitted.length > 0 ? 'tool_calls' : 'stop',
          },
        ],
      };
      res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    } catch (error) {
      const errorChunk = {
        error: {
          message: String(error),
          type: 'server_error',
        },
      };
      res.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
      res.end();
    }
  });
}

async function handleNonStreamingRequest(
  res: Response,
  deps: EndpointDependencies,
  request: OpenAIChatRequest,
  turns: Turn[],
  conversationId: ConversationId
): Promise<void> {
  const ctx = buildRequestContext(deps, conversationId, request.tools);

  const chatResult = await deps.queue.add(async () =>
    deps.lumoClient.chatWithHistory(turns, undefined, {
      enableEncryption: true,
      enableExternalTools: ctx.enableExternalTools,
      commandContext: ctx.commandContext,
      requestTitle: ctx.requestTitle,
    })
  );

  persistTitle(chatResult, deps, conversationId);
  const { content, toolCalls: processedTools } = extractToolsFromResponse(chatResult.response, ctx.hasCustomTools);
  persistResponse(deps, conversationId, content);

  // Convert to OpenAI format with call IDs
  const toolCalls: OpenAIToolCall[] | undefined = processedTools.length > 0
    ? processedTools.map(tc => ({
        id: generateCallId(),
        type: 'function' as const,
        function: { name: tc.name, arguments: tc.arguments },
      }))
    : undefined;

  const response: OpenAIChatResponse = {
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: request.model || getServerConfig().apiModelName,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content,
          ...(toolCalls ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: toolCalls ? 'tool_calls' : 'stop',
      },
    ],
  };

  res.json(response);
}
