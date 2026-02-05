import { randomUUID } from 'crypto';
import { getToolsConfig } from '../../app/config.js';
import { logger } from '../../app/logger.js';
import { StreamingToolDetector } from '../streaming-tool-detector.js';
import { extractToolCallsFromResponse, stripToolCallsFromResponse } from '../tool-parser.js';
import { postProcessTitle } from '../../proton-shims/lumo-api-client-utils.js';
import type { ParsedToolCall } from '../tool-parser.js';
import type { EndpointDependencies, OpenAITool, OpenAIToolCall } from '../types.js';
import type { CommandContext } from '../../app/commands.js';
import type { ConversationId } from '../../conversations/index.js';
import type { ChatResult } from '../../lumo-client/index.js';

// ── Request context ────────────────────────────────────────────────

export interface RequestContext {
  enableExternalTools: boolean;
  hasCustomTools: boolean;
  commandContext: CommandContext;
  requestTitle: boolean;
}

/**
 * Build the common request context shared by all handler variants.
 */
export function buildRequestContext(
  deps: EndpointDependencies,
  conversationId: ConversationId,
  tools?: OpenAITool[]
): RequestContext {
  const toolsConfig = getToolsConfig();
  return {
    enableExternalTools: toolsConfig?.enableWebSearch ?? false,
    hasCustomTools: toolsConfig.enabled && !!tools && tools.length > 0,
    commandContext: {
      syncInitialized: deps.syncInitialized ?? false,
      conversationId,
      authManager: deps.authManager,
    },
    requestTitle: deps.conversationStore?.get(conversationId)?.title === 'New Conversation',
  };
}

// ── Persistence helpers ────────────────────────────────────────────

/** Persist title if Lumo generated one. */
export function persistTitle(result: ChatResult, deps: EndpointDependencies, conversationId: ConversationId): void {
  if (result.title && deps.conversationStore) {
    deps.conversationStore.setTitle(conversationId, postProcessTitle(result.title));
  }
}

/** Persist assistant response text. */
export function persistResponse(deps: EndpointDependencies, conversationId: ConversationId, content: string): void {
  if (deps.conversationStore) {
    deps.conversationStore.appendAssistantResponse(conversationId, content);
    logger.debug({ conversationId }, 'Persisted assistant response');
  }
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

// ── Confused tool call rescue ─────────────────────────────────────

/**
 * Merge a "confused" tool call into existing tool calls.
 *
 * A confused tool call is a custom (client-defined) tool that Lumo mistakenly
 * routed through its native SSE pipeline instead of outputting as text.
 * It always fails server-side, so we rescue it into OpenAI-compatible format.
 *
 * Deduplicates by name: if a text-detected tool call with the same name already
 * exists, the confused call is skipped.
 */
export function mergeConfusedToolCall(
  nativeToolCall: ParsedToolCall | undefined,
  existingToolCalls: ProcessedToolCall[]
): ProcessedToolCall[] {
  if (!nativeToolCall) return existingToolCalls;
  const alreadyPresent = existingToolCalls.some(tc => tc.name === nativeToolCall.name);
  if (alreadyPresent) return existingToolCalls;

  logger.debug({ name: nativeToolCall.name }, '[Server] Rescuing confused tool call');
  return [
    ...existingToolCalls,
    { name: nativeToolCall.name, arguments: JSON.stringify(nativeToolCall.arguments) },
  ];
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
  /** Suppress text deltas (called when native tool call failed internally). */
  setSuppressText(): void;
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
  let suppressText = false;

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
    setSuppressText(): void {
      suppressText = true;
    },
    onChunk(chunk: string): void {
      if (detector) {
        const { textToEmit, completedToolCalls } = detector.processChunk(chunk);
        if (textToEmit && !suppressText) emitter.emitTextDelta(textToEmit);
        processToolCalls(completedToolCalls);
      } else {
        if (!suppressText) emitter.emitTextDelta(chunk);
      }
    },
    finalize(): void {
      if (detector) {
        const { textToEmit, completedToolCalls } = detector.finalize();
        if (textToEmit && !suppressText) emitter.emitTextDelta(textToEmit);
        processToolCalls(completedToolCalls);
      }
    },
  };
}
