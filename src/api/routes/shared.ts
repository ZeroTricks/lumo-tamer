import { randomUUID } from 'crypto';
import type { Response } from 'express';
import { getCustomToolsConfig } from '../../app/config.js';
import { getMetrics } from '../../app/metrics';
import type { CommandContext } from '../../app/commands.js';
import type { EndpointDependencies, OpenAITool, OpenAIToolCall } from '../types.js';
import type { ConversationId } from '../../conversations/types.js';
import type { ChatResult, AssistantMessageData, Turn } from '../../lumo-client/index.js';
import type { LumoUsage } from '../../lumo-client/types.js';

// Re-export for convenience
export { tryExecuteCommand, type CommandResult } from '../../app/commands.js';

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
  deps.conversationStore.setTitle(conversationId, result.title);  // Already processed by LumoClient
}

/**
 * Persist an assistant turn.
 *
 * When custom tool calls are present, we skip persistence entirely. The client (e.g. Home Assistant)
 * will send the assistant message back with the tool output in the next request, and
 * appendMessages() will handle it via ID-based deduplication. This avoids order mismatches
 * between what we persist and what the client sends back.
 *
 * Native tool calls (web_search, weather, etc.) are handled differently - they are executed
 * server-side by Lumo, so we persist them immediately with the tool call/result data.
 * The message data (including JSON-serialized tool call) comes from ChatResult.message.
 */
export function persistAssistantTurn(
  deps: EndpointDependencies,
  conversationId: ConversationId | undefined,
  message: AssistantMessageData,
  customToolCalls?: Array<{ name: string; arguments: string; call_id: string }>
): void {
  if (conversationId && deps.conversationStore) {
    // Custom tool calls: skip persistence (client will send back)
    if (customToolCalls && customToolCalls.length > 0) {
      return;
    }

    // Persist message (with or without native tool data)
    deps.conversationStore.appendAssistantResponse(conversationId, message);
  } else {
    // Stateless: track metric only (no persistence)
    getMetrics()?.messagesTotal.inc({ role: 'assistant' });
  }
}

// ── Usage forwarding ───────────────────────────────────────────────

/**
 * Build an OpenAI-style usage object from Proton's LumoUsage.
 *
 * Proton reports completion tokens but NOT prompt tokens (see LumoUsage docs).
 * To keep gateway cost accounting meaningful, prompt tokens are estimated from
 * the request payload at ~4 chars/token (a standard heuristic for English
 * text) and marked with a `prompt_tokensEstimated: true` flag so downstream
 * consumers know it is not an upstream-reported count. When Proton omits
 * completion tokens too, the completion count is estimated the same way and
 * flagged with `completion_tokensEstimated: true`.
 */
export function buildOpenAIUsage(
  usage: LumoUsage | undefined,
  turns: Turn[],
  completionText: string
): { prompt_tokens: number; completion_tokens: number; total_tokens: number; prompt_tokensEstimated?: boolean; completion_tokensEstimated?: boolean } | null {
  if (!usage) return null;
  const completion = typeof usage.completion_tokens === 'number' && usage.completion_tokens > 0
    ? usage.completion_tokens
    : Math.ceil(completionText.length / 4);
  let promptChars = 0;
  for (const t of turns) {
    promptChars += (t.content ?? '').length;
  }
  const prompt = Math.ceil(promptChars / 4);
  const out: { prompt_tokens: number; completion_tokens: number; total_tokens: number; prompt_tokensEstimated?: boolean; completion_tokensEstimated?: boolean } = {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
  };
  // Flag which side was estimated. Upstream normally reports completion
  // tokens; when it does not, the completion count is our estimate.
  if (typeof usage.completion_tokens !== 'number' || usage.completion_tokens <= 0) {
    out.completion_tokensEstimated = true;
  }
  return out;
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
