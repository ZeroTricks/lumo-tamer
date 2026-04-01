import { randomUUID } from 'crypto';
import type { Response } from 'express';
import { getServerConfig } from '../../app/config.js';
import type { EndpointDependencies, OpenAITool, RequestContext } from '../types.js';
import type { ConversationId } from '../../conversations/types.js';

// Re-export for convenience
export { tryExecuteCommand, type CommandResult } from '../../app/commands.js';

/**
 * Build the common request context shared by all handler variants.
 * When conversationId is undefined (stateless request), requestTitle is false.
 */
export function buildRequestContext(
  deps: EndpointDependencies,
  conversationId: ConversationId | undefined,
  tools?: OpenAITool[]
): RequestContext {

  const { tools: {
    server: { enabled: serverToolsEnabled },
    client: { enabled: clientToolsEnabled }
  } } = getServerConfig();

  // Enable tool detection if either client tools or server tools are active
  const hasClientTools = clientToolsEnabled && !!tools && tools?.length > 0;

  return {
    hasCustomTools: hasClientTools || serverToolsEnabled,
    commandContext: {
      syncInitialized: deps.syncInitialized ?? false,
      conversationId,
      authManager: deps.authManager,
    },
    // Only request title for stateful conversations that haven't been titled yet
    requestTitle: conversationId
      ? deps.conversationStore?.get(conversationId)?.title === 'New Conversation'
      : false,
  };
}

// ── ID generation ─────────────────────────────────────────────────

/** Generate a response ID (`resp-xxx`). */
export function generateResponseId(): string {
  return `resp-${randomUUID()}`;
}

/** Generate an output item ID (`item-xxx`). */
export function generateItemId(): string {
  return `item-${randomUUID()}`;
}

/** Generate a function call item ID (`fc-xxx`). */
export function generateFunctionCallId(): string {
  return `fc-${randomUUID()}`;
}

/** Generate a chat completion ID (`chatcmpl-xxx`). */
export function generateChatCompletionId(): string {
  return `chatcmpl-${randomUUID()}`;
}

// ── SSE headers ───────────────────────────────────────────────────

/** Set standard SSE headers on the response. */
export function setSSEHeaders(res: Response): void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
}
