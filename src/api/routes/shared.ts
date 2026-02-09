import { randomUUID } from 'crypto';
import { getCustomToolsConfig } from '../../app/config.js';
import { logger } from '../../app/logger.js';
import { StreamingToolDetector } from '../tools/streaming-tool-detector.js';
import { extractToolCallsFromResponse, stripToolCallsFromResponse } from '../tools/tool-parser.js';
import { postProcessTitle } from '../../proton-shims/lumo-api-client-utils.js';
import type { ParsedToolCall } from '../tools/tool-parser.js';
import type { EndpointDependencies, OpenAITool, OpenAIToolCall } from '../types.js';
import type { CommandContext } from '../../app/commands.js';
import type { ConversationId } from '../../conversations/index.js';
import type { ChatResult } from '../../lumo-client/index.js';

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
  logger.debug({ conversationId }, 'Persisted assistant response');
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
    deps.conversationStore.addGeneratedCallId(conversationId, tc.call_id);
  }

  logger.debug({ conversationId, toolCount: toolCalls.length }, 'Persisted assistant response with tool calls');
}

// ── Non-streaming tool extraction ──────────────────────────────────

export interface ProcessedToolCall {
  name: string;
  arguments: string; // JSON string
}

export interface ProcessedResult {
  /** Response text with tool JSON stripped (if tools were detected). */
  content: string;
  /** Parsed tool calls (empty array if none). */
  toolCalls: ProcessedToolCall[];
}

/** Extract tool calls from a non-streaming response and return cleaned content. */
export function extractToolsFromResponse(response: string, hasCustomTools: boolean): ProcessedResult {
  let content = response;
  const toolCalls: ProcessedToolCall[] = [];

  if (hasCustomTools) {
    const parsed = extractToolCallsFromResponse(response);
    if (parsed) {
      for (const tc of parsed) {
        toolCalls.push({ name: tc.name, arguments: JSON.stringify(tc.arguments) });
      }
      content = stripToolCallsFromResponse(response, parsed);
      logger.debug(
        { toolCount: toolCalls.length, names: toolCalls.map(tc => tc.name) },
        '[Server] Tool calls detected in response'
      );
    }
  }

  return { content, toolCalls };
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
      logger.debug({ name: tc.name }, '[Server] Tool call emitted in stream');
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
