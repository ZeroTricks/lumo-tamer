import { Router, Request, Response } from 'express';
import { randomUUID, createHash } from 'crypto';
import { EndpointDependencies, OpenAIResponseRequest, FunctionCallOutput } from '../../types.js';
import { logger } from '../../../logger.js';
import { handleStreamingRequest, handleNonStreamingRequest } from './handlers.js';
import { createEmptyResponse } from './response-factory.js';
import { convertResponseInputToTurns } from '../../message-converter.js';
import { isCommand, executeCommand } from '../../commands.js';
import type { Turn } from '../../../lumo-client/index.js';
import type { ConversationId } from '../../../persistence/index.js';

/**
 * Generate a deterministic UUID v5-like ID from the first user message.
 * This ensures that conversations with the same starting message get the same ID,
 * which is important for clients like Home Assistant that send full history
 * without a conversation_id.
 */
function generateDeterministicConversationId(firstUserMessage: string): ConversationId {
  const hash = createHash('sha256').update(`lumo-bridge:${firstUserMessage}`).digest('hex');
  // Format as UUID: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
  // Use version 4 format but with deterministic bytes
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

export function createResponsesRouter(deps: EndpointDependencies): Router {
  const router = Router();

  // Track last processed user message to avoid duplicate processing
  let lastProcessedUserMessage: string | null = null;

  // Track function call outputs and call_ids we created
  let lastProcessedFunctionOutputCallId: string | null = null;
  const createdCallIds = new Set<string>();

  router.post('/v1/responses', async (req: Request, res: Response) => {
    try {
      const request: OpenAIResponseRequest = req.body;

      // Check for function_call_output in input array
      // Note: Tool calls are not supported in API mode, but we keep the deduplication logic
      // in case tool calls are added later
      if (Array.isArray(request.input)) {
        const functionOutputs = request.input
          .filter((item): item is FunctionCallOutput =>
            typeof item === 'object' && 'type' in item && item.type === 'function_call_output'
          )
          .filter((item) => createdCallIds.has(item.call_id));

        // Get the last function output if any
        const lastFunctionOutput = functionOutputs[functionOutputs.length - 1];

        if (lastFunctionOutput) {
          // Check if this call_id is different from last processed
          if (lastFunctionOutput.call_id !== lastProcessedFunctionOutputCallId) {
            lastProcessedFunctionOutputCallId = lastFunctionOutput.call_id;

            logger.debug(`[Server] Processing function_call_output for call_id: ${lastFunctionOutput.call_id}`);

            // Convert function output to a turn
            const outputString = JSON.stringify(lastFunctionOutput);
            const turns: Turn[] = [{ role: 'user', content: outputString }];

            if (request.stream) {
              await handleStreamingRequest(req, res, deps, request, turns, createdCallIds);
            } else {
              await handleNonStreamingRequest(req, res, deps, request, turns, createdCallIds);
            }
            return; // Early return after processing
          }
          // If duplicate function_call_output, continue to check user message
          logger.debug('[Server] Skipping duplicate function_call_output, checking for user message');
        }
      }

      // Extract input text for command checking and deduplication
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

      // Check if this message has already been processed
      if (inputText === lastProcessedUserMessage) {
        logger.debug('[Server] Skipping duplicate user message');
        return res.json(createEmptyResponse(request));
      }

      // Update last processed message
      lastProcessedUserMessage = inputText;

      // Extract or generate conversation ID for persistence
      // For Responses API, use conversation_id, previous_response_id as continuation hint, or generate deterministic ID
      // Note: Must be a valid UUID for Lumo server compatibility (no prefixes)
      let conversationId: ConversationId;
      if (request.conversation_id) {
        conversationId = request.conversation_id;
      } else if (request.previous_response_id) {
        conversationId = request.previous_response_id;
      } else {
        // Generate deterministic ID from first USER message so conversations with same start get same ID
        // This is important for clients like Home Assistant that send full history without conversation_id
        // Note: We use first user message, not first message (which might be assistant greeting)
        const firstUserMessage = Array.isArray(request.input)
          ? request.input.find((m): m is { role: string; content: string } =>
              typeof m === 'object' && 'role' in m && m.role === 'user' && 'content' in m
            )?.content
          : typeof request.input === 'string' ? request.input : undefined;

        conversationId = firstUserMessage
          ? generateDeterministicConversationId(firstUserMessage)
          : randomUUID();

        logger.debug({ conversationId, firstUserMessage: firstUserMessage?.slice(0, 50) }, 'Generated deterministic conversation ID');
      }

      // Persist all messages from input to conversation store
      // The deduplication logic in appendMessages will filter out already-stored messages
      if (deps.conversationStore && Array.isArray(request.input)) {
        // Extract all user and assistant messages from input (not function outputs)
        const allMessages = request.input
          .filter((item): item is { role: string; content: string } => {
            if (typeof item !== 'object') return false;
            if ('type' in item && item.type === 'function_call_output') return false;
            return 'role' in item && 'content' in item &&
              (item.role === 'user' || item.role === 'assistant');
          })
          .map(m => ({ role: m.role, content: m.content }));

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
        await handleStreamingRequest(req, res, deps, request, turns, createdCallIds, conversationId);
      } else {
        await handleNonStreamingRequest(req, res, deps, request, turns, createdCallIds, conversationId);
      }
    } catch (error) {
      logger.error('Error processing response:');
      logger.error(error);
      res.status(500).json({ error: String(error) });
    }
  });

  return router;
}
