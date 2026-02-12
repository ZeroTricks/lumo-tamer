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

// Native SSE tool parsing
export {
  parseNativeToolCallJson,
  isErrorResult,
} from './native-tool-parser.js';

// Tool call types
export { isToolCallJson, type ParsedToolCall } from './types.js';

// Streaming detection
export { StreamingToolDetector, type ProcessResult } from './streaming-tool-detector.js';

// JSON brace tracking
export { JsonBraceTracker } from './json-brace-tracker.js';
