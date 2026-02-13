/**
 * Tool-related utilities
 *
 * Re-exports for clean imports from other modules.
 */

// Prefix helpers
export {
  applyToolPrefix,
  stripToolPrefix,
  applyToolNamePrefix,
} from './prefix.js';

// Tool call types
export { isToolCallJson, type ParsedToolCall } from './types.js';

// Streaming detection
export { StreamingToolDetector, type ProcessResult } from './streaming-tool-detector.js';

// JSON brace tracking
export { JsonBraceTracker } from './json-brace-tracker.js';

// Call ID utilities
export {
  generateCallId,
  extractToolNameFromCallId,
  trackCustomToolCompletion,
  addToolNameToFunctionOutput,
} from './call-id.js';

// Streaming processor
export {
  createStreamingToolProcessor,
  createAccumulatingToolProcessor,
  type StreamingToolEmitter,
  type StreamingToolProcessor,
  type AccumulatingToolProcessor,
} from './streaming-processor.js';

// Native tool call processing (Lumo SSE tool_call/tool_result)
export {
  NativeToolCallProcessor,
  type NativeToolCallResult,
} from './native-tool-call-processor.js';
