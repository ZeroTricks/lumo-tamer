/**
 * Unit tests for native-tool-parser
 *
 * Tests parsing of native SSE tool_call and tool_result JSON.
 */

import { describe, it, expect } from 'vitest';
import { parseNativeToolCallJson, isErrorResult } from '../../src/api/tools/native-tool-parser.js';

describe('parseNativeToolCallJson', () => {
  it('parses valid tool call with arguments', () => {
    const result = parseNativeToolCallJson('{"name":"search","arguments":{"q":"test"}}');
    expect(result).toEqual({ name: 'search', arguments: { q: 'test' } });
  });

  it('normalizes parameters to arguments', () => {
    const result = parseNativeToolCallJson('{"name":"web_search","parameters":{"search_term":"hello"}}');
    expect(result).toEqual({ name: 'web_search', arguments: { search_term: 'hello' } });
  });

  it('prefers arguments over parameters when both present', () => {
    const result = parseNativeToolCallJson('{"name":"test","arguments":{"a":1},"parameters":{"b":2}}');
    expect(result).toEqual({ name: 'test', arguments: { a: 1 } });
  });

  it('defaults to empty arguments when neither field is present', () => {
    const result = parseNativeToolCallJson('{"name":"GetLiveContext"}');
    expect(result).toEqual({ name: 'GetLiveContext', arguments: {} });
  });

  it('handles empty arguments object', () => {
    const result = parseNativeToolCallJson('{"name":"GetLiveContext","arguments":{}}');
    expect(result).toEqual({ name: 'GetLiveContext', arguments: {} });
  });

  it('returns null for missing name field', () => {
    expect(parseNativeToolCallJson('{"arguments":{}}')).toBeNull();
  });

  it('returns null for non-string name', () => {
    expect(parseNativeToolCallJson('{"name":123,"arguments":{}}')).toBeNull();
  });

  it('returns null for invalid JSON', () => {
    expect(parseNativeToolCallJson('not json')).toBeNull();
  });

  it('returns null for null JSON', () => {
    expect(parseNativeToolCallJson('null')).toBeNull();
  });

  it('returns null for array JSON', () => {
    expect(parseNativeToolCallJson('[1,2,3]')).toBeNull();
  });

  it('parses OpenAI-style function_call with JSON string arguments', () => {
    const result = parseNativeToolCallJson('{"type":"function_call","name":"exec","arguments":"{\\"command\\":\\"echo hi\\"}"}');
    expect(result).toEqual({ name: 'exec', arguments: { command: 'echo hi' } });
  });

  it('parses JSON-string arguments', () => {
    const result = parseNativeToolCallJson('{"name":"test","arguments":"{\\"a\\":1}"}');
    expect(result).toEqual({ name: 'test', arguments: { a: 1 } });
  });

  it('supports nested OpenAI function shape', () => {
    const result = parseNativeToolCallJson('{"type":"function","function":{"name":"test","arguments":"{\\"a\\":1}"}}');
    expect(result).toEqual({ name: 'test', arguments: { a: 1 } });
  });

  it('treats malformed string arguments as empty object', () => {
    const result = parseNativeToolCallJson('{"name":"test","arguments":"{not-json"}');
    expect(result).toEqual({ name: 'test', arguments: {} });
  });

  it('treats non-object arguments as empty object', () => {
    const result = parseNativeToolCallJson('{"name":"test","arguments":123}');
    expect(result).toEqual({ name: 'test', arguments: {} });
  });
});

describe('isErrorResult', () => {
  it('returns true for error result', () => {
    expect(isErrorResult('{"error":true}')).toBe(true);
  });

  it('returns false for success result', () => {
    expect(isErrorResult('{"result":"some data"}')).toBe(false);
  });

  it('returns false for error: false', () => {
    expect(isErrorResult('{"error":false}')).toBe(false);
  });

  it('returns false for error as string', () => {
    expect(isErrorResult('{"error":"true"}')).toBe(false);
  });

  it('returns false for invalid JSON', () => {
    expect(isErrorResult('not json')).toBe(false);
  });

  it('returns false for non-object JSON', () => {
    expect(isErrorResult('null')).toBe(false);
  });

  it('returns false for plain text result', () => {
    expect(isErrorResult('Mock search result data')).toBe(false);
  });
});
