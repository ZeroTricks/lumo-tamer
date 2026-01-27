import { Router, Request, Response } from 'express';
import { randomUUID, createHash } from 'crypto';
import { EndpointDependencies, OpenAIChatRequest, OpenAIStreamChunk, OpenAIChatResponse, OpenAIToolCall } from '../types.js';
import { getServerConfig, getToolsConfig, getConversationsConfig } from '../../app/config.js';
import { logger } from '../../app/logger.js';

const serverConfig = getServerConfig();
const toolsConfig = getToolsConfig();
const conversationsConfig = getConversationsConfig();
import { convertMessagesToTurns } from '../message-converter.js';
import { extractToolCallsFromResponse, stripToolCallsFromResponse } from '../tool-parser.js';
import { StreamingToolDetector } from '../streaming-tool-detector.js';
import type { Turn } from '../../lumo-client/index.js';
import type { CommandContext } from '../../app/commands.js';
import type { ConversationId } from '../../conversations/index.js';
import { postProcessTitle } from '../../proton-shims/lumo-api-client-utils.js';

// Session ID generated once at module load - makes deterministic IDs unique per server session
const SESSION_ID = randomUUID();

/**
 * Generate a deterministic conversation ID from the first user message.
 * Used when deriveIdFromFirstMessage is enabled (e.g., for clients that re-send full history).
 */
function generateDeterministicConversationId(firstUserMessage: string): ConversationId {
  const hash = createHash('sha256').update(`lumo-bridge:${SESSION_ID}:${firstUserMessage}`).digest('hex');
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
      // We use deriveIdFromFirstMessage to track conversations for Proton sync.
      let conversationId: ConversationId;
      if (conversationsConfig?.deriveIdFromFirstMessage) {
        // Generate deterministic ID from first user message
        const firstUserMessage = request.messages.find(m => m.role === 'user');
        conversationId = firstUserMessage
          ? generateDeterministicConversationId(firstUserMessage.content)
          : randomUUID();
        logger.debug({ conversationId, firstUserMessage: firstUserMessage?.content.slice(0, 50) }, 'Generated deterministic conversation ID');
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
    model: request.model || serverConfig.apiModelName,
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
    model: request.model || serverConfig.apiModelName,
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
    model: request.model || serverConfig.apiModelName,
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

  // Determine if external tools (web_search, etc.) should be enabled
  const enableExternalTools = toolsConfig.enableWebSearch;

  // Check if request has custom tools AND tools are enabled
  const hasCustomTools = toolsConfig.enabled && request.tools && request.tools.length > 0;

  await deps.queue.add(async () => {
    const id = `chatcmpl-${randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);
    const client = deps.lumoClient;

    // Create detector if custom tools are provided
    const detector = hasCustomTools ? new StreamingToolDetector() : null;
    const toolCallsEmitted: OpenAIToolCall[] = [];
    let toolCallIndex = 0;
    let accumulatedText = '';  // Track full response for persistence

    // Helper to emit content delta chunk
    const emitContentDelta = (content: string) => {
      if (!content) return;
      accumulatedText += content;  // Accumulate for persistence
      const sseChunk: OpenAIStreamChunk = {
        id,
        object: 'chat.completion.chunk',
        created,
        model: request.model || serverConfig.apiModelName,
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
        model: request.model || serverConfig.apiModelName,
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

      const result = await client.chatWithHistory(
        turns,
        (chunk: string) => {
          if (detector) {
            // Use streaming tool detector
            const { textToEmit, completedToolCalls } = detector.processChunk(chunk);

            // Emit text delta if any
            emitContentDelta(textToEmit);

            // Emit tool call deltas for completed tools
            for (const tc of completedToolCalls) {
              const callId = `call_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
              toolCallsEmitted.push({
                id: callId,
                type: 'function',
                function: {
                  name: tc.name,
                  arguments: JSON.stringify(tc.arguments),
                },
              });

              emitToolCallDelta(toolCallIndex++, callId, tc.name, tc.arguments);
              logger.debug({ name: tc.name }, '[Server] Tool call emitted in stream');
            }
          } else {
            // No tools - pass through directly
            emitContentDelta(chunk);
          }
        },
        { enableEncryption: true, enableExternalTools, commandContext, requestTitle }
      );
      logger.debug('[Server] Stream completed');

      // Finalize detector and emit any remaining content
      if (detector) {
        const { textToEmit, completedToolCalls } = detector.finalize();
        emitContentDelta(textToEmit);

        for (const tc of completedToolCalls) {
          const callId = `call_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
          toolCallsEmitted.push({
            id: callId,
            type: 'function',
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.arguments),
            },
          });
          emitToolCallDelta(toolCallIndex++, callId, tc.name, tc.arguments);
        }
      }

      // Save generated title if present
      if (result.title && deps.conversationStore) {
        const processedTitle = postProcessTitle(result.title);
        deps.conversationStore.setTitle(conversationId, processedTitle);
        logger.debug({ conversationId, title: processedTitle }, 'Set generated title');
      }

      // Persist assistant response
      if (deps.conversationStore) {
        deps.conversationStore.appendAssistantResponse(conversationId, result.response);
        logger.debug({ conversationId }, 'Persisted assistant response');
      }

      // Send final chunk with finish_reason
      const finalChunk: OpenAIStreamChunk = {
        id,
        object: 'chat.completion.chunk',
        created,
        model: request.model || serverConfig.apiModelName,
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: toolCallsEmitted.length > 0 ? 'tool_calls' : 'stop',
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
  // Determine if external tools (web_search, etc.) should be enabled
  const enableExternalTools = toolsConfig.enableWebSearch;

  // Check if request has custom tools AND tools are enabled
  const hasCustomTools = toolsConfig.enabled && request.tools && request.tools.length > 0;

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

  const chatResult = await deps.queue.add(async () => {
    const client = deps.lumoClient;
    return await client.chatWithHistory(
      turns,
      undefined,
      { enableEncryption: true, enableExternalTools, commandContext, requestTitle }
    );
  });

  // Save generated title if present
  if (chatResult.title && deps.conversationStore) {
    const processedTitle = postProcessTitle(chatResult.title);
    deps.conversationStore.setTitle(conversationId, processedTitle);
    logger.debug({ conversationId, title: processedTitle }, 'Set generated title');
  }

  // Parse tool calls from response if custom tools were provided
  let content = chatResult.response;
  let toolCalls: OpenAIToolCall[] | undefined;

  if (hasCustomTools) {
    const parsedToolCalls = extractToolCallsFromResponse(chatResult.response);
    if (parsedToolCalls) {
      logger.debug({ count: parsedToolCalls.length }, '[Server] Tool calls detected');

      // Convert to OpenAI format
      toolCalls = parsedToolCalls.map((tc) => ({
        id: `call_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
        type: 'function' as const,
        function: {
          name: tc.name,
          arguments: JSON.stringify(tc.arguments),
        },
      }));

      // Strip tool call JSON from content
      content = stripToolCallsFromResponse(chatResult.response, parsedToolCalls);
    }
  }

  // Persist assistant response
  if (deps.conversationStore) {
    deps.conversationStore.appendAssistantResponse(conversationId, content);
    logger.debug({ conversationId }, 'Persisted assistant response');
  }

  const response: OpenAIChatResponse = {
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: request.model || serverConfig.apiModelName,
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
