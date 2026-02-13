import { randomUUID } from 'crypto';
import { getCustomToolsConfig } from '../../app/config.js';
import { postProcessTitle } from '../../proton-shims/lumo-api-client-utils.js';
import { getMetrics } from '../metrics/index.js';
import type { EndpointDependencies, OpenAITool, OpenAIToolCall } from '../types.js';
import type { CommandContext } from '../../app/commands.js';
import type { ConversationId } from '../../conversations/types.js';
import type { ChatResult } from '../../lumo-client/index.js';

// ── Tool call type for persistence ─────────────────────────────────

/** Tool call with call_id for persistence and response building. */
export interface ToolCallForPersistence {
  name: string;
  arguments: string;
  call_id: string;
}

/**
 * Map emitted tool calls to format needed for persistence.
 * Returns undefined if no tool calls were emitted.
 */
export function mapToolCallsForPersistence(
  toolCallsEmitted: OpenAIToolCall[]
): ToolCallForPersistence[] | undefined {
  if (toolCallsEmitted.length === 0) return undefined;
  return toolCallsEmitted.map(tc => ({
    name: tc.function.name,
    arguments: tc.function.arguments,
    call_id: tc.id,
  }));
}

// ── Request context ────────────────────────────────────────────────

export interface RequestContext {
  hasCustomTools: boolean;
  commandContext: CommandContext;
  requestTitle: boolean;
}

/**
 * Build the common request context shared by all handler variants.
 * When conversationId is undefined (stateless request), requestTitle is false.
 */
export function buildRequestContext(
  deps: EndpointDependencies,
  conversationId: ConversationId | undefined,
  tools?: OpenAITool[]
): RequestContext {
  const serverToolsConfig = getCustomToolsConfig();
  return {
    hasCustomTools: serverToolsConfig.enabled && !!tools && tools.length > 0,
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

// ── Persistence helpers ────────────────────────────────────────────

/** Persist title if Lumo generated one. No-op for stateless requests. */
export function persistTitle(result: ChatResult, deps: EndpointDependencies, conversationId: ConversationId | undefined): void {
  if (!conversationId || !result.title || !deps.conversationStore) return;
  deps.conversationStore.setTitle(conversationId, postProcessTitle(result.title));
}

/** Persist assistant response text. No-op for stateless requests. */
export function persistResponse(deps: EndpointDependencies, conversationId: ConversationId | undefined, content: string): void {
  if (!conversationId || !deps.conversationStore) return;
  deps.conversationStore.appendAssistantResponse(conversationId, content);
}

/**
 * Persist an assistant turn (response text and optional tool calls).
 */
export function persistAssistantTurn(
  deps: EndpointDependencies,
  conversationId: ConversationId | undefined,
  content: string,
  toolCalls?: Array<{ name: string; arguments: string; call_id: string }>
): void {
  if (conversationId && deps.conversationStore) {
    // Stateful: persist to store
    if (toolCalls && toolCalls.length > 0) {
      persistResponseWithToolCalls(deps, conversationId, content, toolCalls);
    } else {
      persistResponse(deps, conversationId, content);
    }
  } else {
    // Stateless: track metric only (no persistence)
    getMetrics()?.messagesTotal.inc({ role: 'assistant' });
  }
}

/**
 * Persist assistant response with tool calls.
 * Each tool call is stored as a separate assistant message with normalized JSON content.
 * No-op for stateless requests.
 *
 * NOTE: We intentionally don't store the stripped text content separately.
 * The OpenAI client sees the response as just the function_call items, not the
 * text that preceded them. Storing the text would cause a mismatch when the
 * client echoes back the conversation history.
 */
export function persistResponseWithToolCalls(
  deps: EndpointDependencies,
  conversationId: ConversationId | undefined,
  _content: string, // Kept for API compatibility but not stored
  toolCalls: Array<{ name: string; arguments: string; call_id: string }>
): void {
  if (!conversationId || !deps.conversationStore) return;

  // Store each tool call as a normalized assistant message
  for (const tc of toolCalls) {
    // Normalize arguments: parse then re-stringify for consistent formatting
    // This ensures stored format matches what normalizeInputItem produces
    const normalizedArgs = JSON.stringify(JSON.parse(tc.arguments));
    const normalizedContent = JSON.stringify({
      type: 'function_call',
      call_id: tc.call_id,
      name: tc.name,
      arguments: normalizedArgs,
    });
    deps.conversationStore.appendAssistantResponse(conversationId, normalizedContent);
  }
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
