/**
 * Streaming tool processor
 *
 * Separates tool call JSON from normal text during streaming.
 * Uses StreamingToolDetector for detection and generateCallId for ID generation.
 */

import { logger } from '../../app/logger.js';
import { StreamingToolDetector } from './streaming-tool-detector.js';
import { generateCallId } from './call-id.js';
import type { ParsedToolCall } from './types.js';
import type { OpenAIToolCall } from '../types.js';

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
      const callId = generateCallId(tc.name);
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
