import { Router, Request, Response } from 'express';
import { EndpointDependencies, OpenAIResponseRequest, OpenAIResponseMessage, FunctionCallOutput } from '../../types.js';
import { logger } from '../../../app/logger.js';
import { handleRequest } from './request-handlers.js';
import { convertOpenAIResponseMessages } from '../../message-converter.js';
import { buildInstructions } from '../../instructions.js';
import { getConversationsConfig, getServerInstructionsConfig, getServerConfig } from '../../../app/config.js';
import { isModelAllowed, normalizeModelId, isValidReasoningEffort } from '../../../lumo-client/model-tier.js';
import { Role } from '../../../lumo-client/index.js';
import { getMetrics } from '../../../app/metrics.js';
import { trackCustomToolCompletion } from '../../tools/call-id.js';
import { sendInvalidRequest, sendServerError } from '../../error-handler.js';
import { deterministicUUID } from '../../../app/id-generator.js';

import type { ConversationId } from '../../../conversations/index.js';

function extractLoosePrompt(input: OpenAIResponseRequest['input']): string {
  if (typeof input === 'string') return input.trim();
  if (!Array.isArray(input)) return '';
  const parts: string[] = [];
  for (const item of input) {
    if (typeof item === 'string') {
      parts.push(item);
      continue;
    }
    if (typeof item !== 'object' || item === null) continue;
    const obj = item as Record<string, unknown>;
    if (typeof obj.content === 'string') parts.push(obj.content);
    else if (typeof obj.text === 'string') parts.push(obj.text);
    else if (Array.isArray(obj.content)) {
      for (const part of obj.content) {
        if (typeof part === 'string') parts.push(part);
        else if (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string') {
          parts.push((part as { text: string }).text);
        }
      }
    }
  }
  return parts.join('\n').trim();
}

/**
 * Generate a deterministic conversation ID from the `user` field in the request.
 * Used for clients like Home Assistant that set `user` to their internal conversation_id.
 *
 * Includes SESSION_ID so IDs are deterministic within a session but unique across sessions.
 */
function generateConversationIdFromUser(user: string): ConversationId {
  const uuid = deterministicUUID(`user:${user}`);
  logger.debug({ user, uuid }, 'Generated deterministic conversation ID from user field');
  return uuid;
}

/**
 * Extract conversation ID from request.conversation field (per OpenAI spec).
 * The client-provided ID is hashed with SESSION_ID to produce a session-scoped UUID.
 *
 * Known limitation: the internal conversation ID will differ across server restarts,
 * even if the client sends the same conversation ID. This is acceptable because the
 * in-memory store doesn't persist across restarts anyway.
 */
function getConversationIdFromRequest(request: OpenAIResponseRequest): ConversationId | undefined {
  let clientId: string | undefined;
  if (!request.conversation) return undefined;
  if (typeof request.conversation === 'string') clientId = request.conversation;
  else if (typeof request.conversation === 'object' && 'id' in request.conversation) {
    clientId = request.conversation.id;
  }
  if (!clientId) return undefined;

  const uuid = deterministicUUID(`conversation:${clientId}`);
  logger.debug({ clientId, uuid }, 'Mapped client-provided conversation ID to session-scoped UUID');
  return uuid;
}

export function createResponsesRouter(deps: EndpointDependencies): Router {
  const router = Router();

  // NOTE: Module-level state has been moved to ConversationStore (per-conversation)
  // This fixes issues with server-global state shared across conversations

  router.post('/v1/responses', async (req: Request, res: Response) => {
    try {
      const request: OpenAIResponseRequest = req.body;

      // Continue / Android Studio / Codex often send Chat Completions `messages`
      // to /v1/responses instead of Responses `input`.
      if (request.input === undefined || request.input === null) {
        if (request.messages !== undefined) {
          request.input = request.messages as OpenAIResponseRequest['input'];
        } else if (typeof request.prompt === 'string') {
          request.input = request.prompt;
        } else if (typeof request.query === 'string') {
          request.input = request.query;
        } else {
          // IDE model/tool probes send tools with no prompt. Answer instead of 400.
          logger.warn({ keys: Object.keys(request as object) }, 'Responses request had no input; using probe prompt');
          request.input = 'Hello';
        }
      }
      if (request.input && !Array.isArray(request.input) && typeof request.input !== 'string') {
        request.input = [request.input as OpenAIResponseMessage];
      }

      // ===== STEP 1: Determine conversation ID =====
      // Without a deterministic ID, treat the request as stateless (no persistence/dedup).
      if (request.previous_response_id && request.conversation) {
        logger.warn('Ignoring previous_response_id because conversation is also set');
        delete request.previous_response_id;
      }

      let conversationId: ConversationId | undefined;
      const conversationFromRequest = getConversationIdFromRequest(request);

      if (conversationFromRequest) {
        // Use conversation field (per OpenAI spec)
        conversationId = conversationFromRequest;
      } else if (request.previous_response_id) {
        // Use previous_response_id for stateless continuation
        conversationId = request.previous_response_id;
      } else if (getConversationsConfig()?.deriveIdFromUser && request.user) {
        // WORKAROUND for clients that don't provide conversation (e.g., Home Assistant).
        // Home Assistant sets `user` to its internal conversation_id, unique per chat session.
        conversationId = generateConversationIdFromUser(request.user);
      }
      // No else - leave undefined for stateless requests

      // ===== STEP 2: Validate input =====
      if (request.input === undefined || request.input === null) {
        return sendInvalidRequest(res, 'input is required (string or message array)', 'input', 'missing_input');
      }
      if (Array.isArray(request.input) && request.input.length === 0 && !request.instructions) {
        logger.warn('Empty input array from client; using probe prompt');
        request.input = 'Hello';
      }

      // Validate model + reasoning effort before any side effects.
      if (request.model !== undefined && request.model !== null) {
        const allowedModels = getServerConfig().allowedModels;
        if (typeof request.model !== 'string') {
          return sendInvalidRequest(
            res,
            `Unknown model '${String(request.model)}'. Allowed models: ${allowedModels.join(', ')}`,
            'model',
            'model_not_found',
          );
        }
        if (!isModelAllowed(normalizeModelId(request.model), allowedModels)) {
          logger.warn(
            { model: request.model, allowedModels },
            'Unknown model from client; falling back to server default',
          );
        }
      }
      if (!isValidReasoningEffort(request.reasoning?.effort)) {
        logger.warn(
          { effort: request.reasoning?.effort },
          'Unknown reasoning.effort from client; using server default',
        );
        if (request.reasoning) request.reasoning.effort = undefined;
      }

      // ===== STEP 3: Convert input to turns =====
      // Handles normal messages, function_call, and function_call_output items.
      let turns = convertOpenAIResponseMessages(request.input, request.instructions);
      if (turns.length === 0) {
        const fallbackPrompt = request.instructions || extractLoosePrompt(request.input);
        if (fallbackPrompt) {
          turns = [{ role: Role.User, content: fallbackPrompt }];
        }
      }

      // ===== Build instructions (injected in LumoClient, not persisted) =====
      const instructions = buildInstructions(request.tools, request.instructions);
      const { injectInto } = getServerInstructionsConfig();

      // ===== STEP 4: Track tool completions =====
      // Track completion for all function_call_outputs (Set-based dedup prevents double-counting)
      if (Array.isArray(request.input)) {
        for (const item of request.input) {
          if (typeof item === 'object' && 'type' in item && (item as FunctionCallOutput).type === 'function_call_output') {
            trackCustomToolCompletion((item as FunctionCallOutput).call_id);
          }
        }
      }

      // ===== STEP 5: Persist incoming messages (stateful only) =====
      if (conversationId && deps.conversationStore && turns.length > 0) {
        deps.conversationStore.appendMessages(conversationId, turns);
        logger.debug({ conversationId, messageCount: turns.length }, 'Persisted conversation messages');
      } else if (!conversationId) {
        // Stateless request - track +1 user message (not deduplicated)
        getMetrics()?.messagesTotal.inc({ role: 'user' });
      }

      // ===== STEP 6: Add to queue and process =====
      await handleRequest(res, deps, request, turns, conversationId, request.stream ?? false, instructions, injectInto);
    } catch (error) {
      logger.error('Error processing response:');
      logger.error(error);
      return sendServerError(res);
    }
  });

  return router;
}
