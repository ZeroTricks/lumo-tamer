import { Router, Request, Response } from 'express';
import { randomUUID, createHash } from 'crypto';
import { EndpointDependencies, OpenAIResponseRequest, FunctionCallOutput } from '../../types.js';
import { logger } from '../../../app/logger.js';
import { handleStreamingRequest, handleNonStreamingRequest } from './handlers.js';
import { createEmptyResponse } from './response-factory.js';
import { convertResponseInputToTurns } from '../../message-converter.js';
import { getConversationsConfig, getLogConfig } from '../../../app/config.js';
import type { Turn } from '../../../lumo-client/index.js';
import type { ConversationId } from '../../../conversations/index.js';

// Session ID generated once at module load - makes deterministic IDs unique per server session
// This prevents 409 conflicts with deleted conversations from previous sessions
const SESSION_ID = randomUUID();

/**
 * Generate a deterministic UUID v5-like ID from the first user message.
 * This ensures that conversations with the same starting message get the same ID,
 * which is important for clients like Home Assistant that send full history
 * without a conversation_id.
 *
 * Includes SESSION_ID so IDs are deterministic within a session but unique across sessions.
 */
function generateDeterministicConversationId(firstUserMessage: string): ConversationId {
  const hash = createHash('sha256').update(`lumo-bridge:${SESSION_ID}:${firstUserMessage}`).digest('hex');
  // Format as UUID: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
  // Use version 4 format but with deterministic bytes
  const uuid =  `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;

  logger.debug(`Generated deterministic conversation ID ${uuid} from first message${getLogConfig().messageContent ? `(${firstUserMessage?.slice(0, 50)})` : ''}`);

  return uuid;
}

/**
 * Extract conversation ID from request.conversation field (per OpenAI spec)
 */
function getConversationIdFromRequest(request: OpenAIResponseRequest): string | undefined {
  if (!request.conversation) return undefined;
  if (typeof request.conversation === 'string') return request.conversation;
  if (typeof request.conversation === 'object' && 'id' in request.conversation) {
    return request.conversation.id;
  }
  return undefined;
}

export function createResponsesRouter(deps: EndpointDependencies): Router {
  const router = Router();

  // NOTE: Module-level state has been moved to ConversationStore (per-conversation)
  // This fixes issues with server-global state shared across conversations

  router.post('/v1/responses', async (req: Request, res: Response) => {
    try {
      const request: OpenAIResponseRequest = req.body;

      // ===== STEP 1: Determine conversation ID FIRST =====
      // We need this before any deduplication checks since dedup is per-conversation
      let conversationId: ConversationId;
      const conversationFromRequest = getConversationIdFromRequest(request);

      if (conversationFromRequest) {
        // Use conversation field (per OpenAI spec)
        conversationId = conversationFromRequest;
      } else if (request.previous_response_id) {
        // Use previous_response_id for stateless continuation
        conversationId = request.previous_response_id;
      } else if (getConversationsConfig()?.deriveIdFromFirstMessage) {
        // WORKAROUND for clients that don't provide conversation (e.g., Home Assistant).
        // Generate deterministic ID from first USER message so conversations with same start get same ID.
        // WARNING: This may incorrectly merge unrelated conversations with the same opening message!
        const firstUserMessage = Array.isArray(request.input)
          ? request.input.find((m): m is { role: string; content: string } =>
              typeof m === 'object' && 'role' in m && m.role === 'user' && 'content' in m
            )?.content
          : typeof request.input === 'string' ? request.input : undefined;

        conversationId = firstUserMessage
          ? generateDeterministicConversationId(firstUserMessage)
          : randomUUID();

      } else {
        // Default: generate random UUID for each new conversation
        conversationId = randomUUID();
        logger.debug({ conversationId }, 'Generated random conversation ID');
      }

      // ===== STEP 2: Check for function_call_output (with per-conversation dedup) =====
      if (Array.isArray(request.input)) {
        const functionOutputs = request.input
          .filter((item): item is FunctionCallOutput =>
            typeof item === 'object' && 'type' in item && item.type === 'function_call_output'
          )
          // Only process outputs for call_ids we generated in THIS conversation
          .filter((item) => deps.conversationStore?.hasGeneratedCallId(conversationId, item.call_id) ?? false);

        // Get the last function output if any
        const lastFunctionOutput = functionOutputs[functionOutputs.length - 1];

        if (lastFunctionOutput) {
          // Check if this call_id is different from last processed (per-conversation)
          const isDuplicate = deps.conversationStore?.isDuplicateFunctionCallId(conversationId, lastFunctionOutput.call_id) ?? false;

          if (!isDuplicate) {
            deps.conversationStore?.setLastFunctionCallId(conversationId, lastFunctionOutput.call_id);

            logger.debug(`[Server] Processing function_call_output for call_id: ${lastFunctionOutput.call_id}`);

            // Convert function output to a turn
            const outputString = JSON.stringify(lastFunctionOutput);
            const turns: Turn[] = [{ role: 'user', content: outputString }];

            if (request.stream) {
              await handleStreamingRequest(req, res, deps, request, turns, conversationId);
            } else {
              await handleNonStreamingRequest(req, res, deps, request, turns, conversationId);
            }
            return; // Early return after processing
          }
          // If duplicate function_call_output, continue to check user message
          logger.debug('[Server] Skipping duplicate function_call_output, checking for user message');
        }
      }

      // ===== STEP 3: Extract input text =====
      let inputText: string;
      if (typeof request.input === 'string') {
        inputText = request.input;
      } else if (Array.isArray(request.input)) {
        // Get the last user message from array
        const lastUserMessage = [...request.input].reverse().find((m): m is { role: string; content: string } =>
          typeof m === 'object' && 'role' in m && m.role === 'user'
        );
        if (!lastUserMessage) {
          return res.status(400).json({ error: 'No user message found in input array' });
        }
        inputText = lastUserMessage.content;
      } else {
        return res.status(400).json({ error: 'Input is required (string or message array)' });
      }

      // ===== STEP 4: Check for duplicate user message (per-conversation) =====
      if (deps.conversationStore?.isDuplicateUserMessage(conversationId, inputText)) {
        logger.debug('[Server] Skipping duplicate user message');
        return res.json(createEmptyResponse(request));
      }

      // Update last user message (per-conversation)
      deps.conversationStore?.setLastUserMessage(conversationId, inputText);

      // Persist all messages from input to conversation store
      // The deduplication logic in appendMessages will filter out already-stored messages
      if (deps.conversationStore && Array.isArray(request.input)) {
        // Extract all messages (including system, tool calls, etc.)
        // Function calls and outputs are converted to a storable format
        const allMessages: Array<{ role: string; content: string }> = [];
        for (const item of request.input) {
          // Use type assertion to access 'type' property safely
          const itemType = 'type' in item ? (item as { type: string }).type : undefined;

          if (itemType === 'function_call') {
            // Convert function_call to a message format
            const fc = item as unknown as { type: string; name: string; arguments: string; call_id: string };
            allMessages.push({
              role: 'tool_call',
              content: JSON.stringify({ call_id: fc.call_id, name: fc.name, arguments: fc.arguments })
            });
          } else if (itemType === 'function_call_output') {
            // Convert function_call_output to a message format
            const fco = item as FunctionCallOutput;
            allMessages.push({
              role: 'tool_result',
              content: JSON.stringify({ call_id: fco.call_id, output: fco.output })
            });
          } else if ('role' in item && 'content' in item) {
            allMessages.push({ role: item.role, content: item.content });
          }
        }

        if (allMessages.length > 0) {
          deps.conversationStore.appendMessages(conversationId, allMessages);
          logger.debug({ conversationId, messageCount: allMessages.length }, 'Persisted conversation messages');
        }
      } else if (deps.conversationStore && typeof request.input === 'string') {
        // Simple string input - just the user message
        deps.conversationStore.appendMessages(conversationId, [
          { role: 'user', content: inputText }
        ]);
        logger.debug({ conversationId }, 'Persisted user message');
      }

      // Convert input to turns (includes instructions injection)
      const turns = convertResponseInputToTurns(request.input, request.instructions, request.tools);

      // Add to queue and process
      if (request.stream) {
        await handleStreamingRequest(req, res, deps, request, turns, conversationId);
      } else {
        await handleNonStreamingRequest(req, res, deps, request, turns, conversationId);
      }
    } catch (error) {
      logger.error('Error processing response:');
      logger.error(error);
      res.status(500).json({ error: String(error) });
    }
  });

  return router;
}
