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

// Tool parsing
export {
  extractToolCallsFromResponse,
  stripToolCallsFromResponse,
  isToolCallJson,
  type ParsedToolCall,
} from './tool-parser.js';

// Native SSE tool parsing
export {
  parseNativeToolCallJson,
  isErrorResult,
} from './native-tool-parser.js';

// Streaming detection
export { StreamingToolDetector, type ProcessResult } from './streaming-tool-detector.js';

// JSON brace tracking
export { JsonBraceTracker } from './json-brace-tracker.js';
