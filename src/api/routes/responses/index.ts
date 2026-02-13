import { Router, Request, Response } from 'express';
import { randomUUID, createHash } from 'crypto';
import { EndpointDependencies, OpenAIResponseRequest, FunctionCallOutput } from '../../types.js';
import { logger } from '../../../app/logger.js';
import { handleRequest } from './request-handlers.js';
import { convertResponseInputToTurns, normalizeInputItem } from '../../message-converter.js';
import { getConversationsConfig } from '../../../app/config.js';
import { getMetrics } from '../../metrics/index.js';
import { trackCustomToolCompletion } from '../shared.js';

import type { ConversationId } from '../../../conversations/types.js';

// Session ID generated once at module load - makes deterministic IDs unique per server session
// This prevents 409 conflicts with deleted conversations from previous sessions
const SESSION_ID = randomUUID();

/**
 * Generate a deterministic UUID from a seed string, scoped to the current session.
 * The same seed within the same session always produces the same UUID,
 * but different sessions produce different UUIDs (prevents sync conflicts).
 */
function deterministicUUID(seed: string): ConversationId {
  const hash = createHash('sha256').update(`lumo-tamer:${SESSION_ID}:${seed}`).digest('hex');
  // Format as UUID: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
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

      // ===== STEP 1: Determine conversation ID =====
      // Without a deterministic ID, treat the request as stateless (no persistence/dedup).
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
      if (!request.input) {
        return res.status(400).json({ error: 'Input is required (string or message array)' });
      }
      if (Array.isArray(request.input)) {
        const hasUserMessage = request.input.some((m) =>
          typeof m === 'object' && 'role' in m && m.role === 'user'
        );
        if (!hasUserMessage) {
          return res.status(400).json({ error: 'No user message found in input array' });
        }
      }

      // ===== STEP 3: Convert input to turns =====
      // Handles normal messages, function_call, and function_call_output items.
      // Injects instructions into the first user turn.
      const turns = convertResponseInputToTurns(request.input, request.instructions, request.tools);

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
      if (conversationId && deps.conversationStore && Array.isArray(request.input)) {
        const allMessages: Array<{ role: string; content: string }> = [];
        for (const item of request.input) {
          // Use normalizeInputItem for tool-related items (function_call, function_call_output)
          const normalized = normalizeInputItem(item);
          if (normalized) {
            const normalizedArray = Array.isArray(normalized) ? normalized : [normalized];
            allMessages.push(...normalizedArray);
          } else if (typeof item === 'object' && 'role' in item && 'content' in item) {
            const msg = item as { role: string; content: string };
            allMessages.push({ role: msg.role, content: msg.content });
          }
        }

        if (allMessages.length > 0) {
          deps.conversationStore.appendMessages(conversationId, allMessages);
          logger.debug({ conversationId, messageCount: allMessages.length }, 'Persisted conversation messages');
        }
      } else if (conversationId && deps.conversationStore && typeof request.input === 'string') {
        deps.conversationStore.appendMessages(conversationId, [
          { role: 'user', content: request.input }
        ]);
        logger.debug({ conversationId }, 'Persisted user message');
      } else if (!conversationId) {
        // Stateless request - track +1 user message (not deduplicated)
        getMetrics()?.messagesTotal.inc({ role: 'user' });
      }

      // Add to queue and process
      await handleRequest(res, deps, request, turns, conversationId, request.stream ?? false);
    } catch (error) {
      logger.error('Error processing response:');
      logger.error(error);
      res.status(500).json({ error: String(error) });
    }
  });

  return router;
}
