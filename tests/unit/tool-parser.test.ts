/**
 * Unit tests for tool-parser
 *
 * Tests the isToolCallJson type guard.
 * Tool call detection is now handled by StreamingToolDetector (see streaming-tool-detector.test.ts).
 */

import { describe, it, expect } from 'vitest';
import { isToolCallJson } from '../../src/api/tools/types.js';

describe('isToolCallJson', () => {
  it('accepts valid tool call with name and arguments', () => {
    expect(isToolCallJson({ name: 'search', arguments: { q: 'test' } })).toBe(true);
  });

  it('accepts tool call with empty arguments', () => {
    expect(isToolCallJson({ name: 'ping', arguments: {} })).toBe(true);
  });

  it('rejects missing name field', () => {
    expect(isToolCallJson({ arguments: {} })).toBe(false);
  });

  it('rejects missing arguments field', () => {
    expect(isToolCallJson({ name: 'test' })).toBe(false);
  });

  it('rejects null', () => {
    expect(isToolCallJson(null)).toBe(false);
  });

  it('rejects non-object', () => {
    expect(isToolCallJson('string')).toBe(false);
    expect(isToolCallJson(42)).toBe(false);
  });

  it('accepts OpenAI-style function_call shape', () => {
    expect(isToolCallJson({ type: 'function_call', name: 'exec', arguments: '{"command":"pwd"}' })).toBe(true);
  });

  it('rejects unsupported type field values', () => {
    expect(isToolCallJson({ type: 'message', name: 'exec', arguments: {} })).toBe(false);
  });

  it('rejects name that is not a string', () => {
    expect(isToolCallJson({ name: 42, arguments: {} })).toBe(false);
  });
});
