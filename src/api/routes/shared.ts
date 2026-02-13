import { randomUUID } from 'crypto';
import { getCustomToolsConfig } from '../../app/config.js';
import { logger } from '../../app/logger.js';
import { StreamingToolDetector } from '../tools/streaming-tool-detector.js';
import { postProcessTitle } from '../../proton-shims/lumo-api-client-utils.js';
import { getMetrics } from '../metrics/index.js';
import type { ParsedToolCall } from '../tools/types.js';
import type { EndpointDependencies, OpenAITool, OpenAIToolCall } from '../types.js';
import type { CommandContext } from '../../app/commands.js';
import type { ConversationId } from '../../conversations/index.js';
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

// ── Tool completion tracking ───────────────────────────────────────

/**
 * Global call_id -> tool_name map for stateless requests.
 * Stateful requests use conversationStore.generatedCallIds instead.
 * Entries are cleaned up when tool completion is tracked.
 */
const statelessCallIds = new Map<string, string>();

/** Register a call_id for stateless tracking. */
export function registerStatelessCallId(callId: string, toolName: string): void {
  statelessCallIds.set(callId, toolName);
}

/**
 * Track completion of a custom tool call.
 * Used by both /v1/responses (function_call_output) and /v1/chat/completions (role: 'tool').
 * Works for both stateful and stateless requests.
 */
export function trackCustomToolCompletion(
  deps: EndpointDependencies,
  conversationId: ConversationId | undefined,
  callId: string
): void {
  // Try conversation store first (stateful)
  let toolName: string | undefined;
  if (conversationId && deps.conversationStore) {
    toolName = deps.conversationStore.getToolNameForCallId(conversationId, callId);
  }
  // Fall back to stateless map
  if (!toolName) {
    toolName = statelessCallIds.get(callId);
    if (toolName) {
      statelessCallIds.delete(callId); // Clean up after use
    }
  }

  if (!toolName) return;

  logger.info({ toolName, call_id: callId }, 'Custom tool call completed');
  getMetrics()?.toolCallsTotal.inc({
    type: 'custom',
    status: 'completed',
    tool_name: toolName,
  });
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
 * For stateless requests, registers tool call_ids for completion tracking.
 */
export function persistAssistantTurn(
  deps: EndpointDependencies,
  conversationId: ConversationId | undefined,
  content: string,
  toolCalls?: Array<{ name: string; arguments: string; call_id: string }>
): void {
  if (conversationId && deps.conversationStore) {
    // Stateful: persist to store (which also registers call_ids)
    if (toolCalls && toolCalls.length > 0) {
      persistResponseWithToolCalls(deps, conversationId, content, toolCalls);
    } else {
      persistResponse(deps, conversationId, content);
    }
  } else {
    // Stateless: track metric and register call_ids for completion tracking
    getMetrics()?.messagesTotal.inc({ role: 'assistant' });
    if (toolCalls) {
      for (const tc of toolCalls) {
        registerStatelessCallId(tc.call_id, tc.name);
      }
    }
  }
}

/**
 * Persist assistant response with tool calls.
 * Each tool call is stored as a separate assistant message with normalized JSON content.
 * Also registers call_ids for deduplication tracking.
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

  // Store each tool call as a normalized assistant message and register call_id
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
    deps.conversationStore.addGeneratedCallId(conversationId, tc.call_id, tc.name);
  }
}

// ── Accumulating tool processor (for non-streaming requests) ───────

export interface AccumulatingToolProcessor {
  /** The underlying streaming processor */
  processor: StreamingToolProcessor;
  /** Get all accumulated text after processing */
  getAccumulatedText: () => string;
}

/**
 * Create a tool processor that accumulates text instead of emitting.
 * Used for non-streaming requests that still process the Lumo stream.
 */
export function createAccumulatingToolProcessor(hasCustomTools: boolean): AccumulatingToolProcessor {
  let accumulatedText = '';

  const processor = createStreamingToolProcessor(hasCustomTools, {
    emitTextDelta(text) { accumulatedText += text; },
    emitToolCall(_callId, _tc) { /* tool calls tracked in processor.toolCallsEmitted */ },
  });

  return {
    processor,
    getAccumulatedText: () => accumulatedText,
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

/** Generate a call_id for tool calls (`call_xxx`). */
export function generateCallId(): string {
  return `call_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

/** Generate a chat completion ID (`chatcmpl-xxx`). */
export function generateChatCompletionId(): string {
  return `chatcmpl-${randomUUID()}`;
}

// ── Streaming tool processor ───────────────────────────────────────

export interface StreamingToolEmitter {
  /** Emit a text delta chunk. */
  emitTextDelta(text: string): void;
  /** Emit a completed tool call. */
  emitToolCall(callId: string, toolCall: ParsedToolCall): void;
}

export interface StreamingToolProcessor {
  /** Process an incoming chunk from Lumo. */
  onChunk(chunk: string): void;
  /** Finalize after stream ends; emits remaining buffered content. */
  finalize(): void;
  /** All tool calls emitted during streaming. */
  toolCallsEmitted: OpenAIToolCall[];
}

/**
 * Create a streaming tool processor that separates tool call JSON
 * from normal text during streaming.
 *
 * Handlers provide format-specific emitter callbacks.
 */
export function createStreamingToolProcessor(
  hasCustomTools: boolean,
  emitter: StreamingToolEmitter
): StreamingToolProcessor {
  const detector = hasCustomTools ? new StreamingToolDetector() : null;
  const toolCallsEmitted: OpenAIToolCall[] = [];

  function processToolCalls(completedToolCalls: ParsedToolCall[]): void {
    for (const tc of completedToolCalls) {
      const callId = generateCallId();
      toolCallsEmitted.push({
        id: callId,
        type: 'function',
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
      });
      emitter.emitToolCall(callId, tc);
      logger.debug({ tool: tc.name }, '[Server] Tool call emitted in stream');
    }
  }

  return {
    toolCallsEmitted,
    onChunk(chunk: string): void {
      if (detector) {
        const { textToEmit, completedToolCalls } = detector.processChunk(chunk);
        if (textToEmit) emitter.emitTextDelta(textToEmit);
        processToolCalls(completedToolCalls);
      } else {
        emitter.emitTextDelta(chunk);
      }
    },
    finalize(): void {
      if (detector) {
        const { textToEmit, completedToolCalls } = detector.finalize();
        if (textToEmit) emitter.emitTextDelta(textToEmit);
        processToolCalls(completedToolCalls);
      }
    },
  };
}
