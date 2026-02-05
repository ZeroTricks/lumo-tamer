/**
 * Unit tests for tool-parser
 *
 * Tests extraction and stripping of tool call JSON from Lumo response text.
 */

import { describe, it, expect } from 'vitest';
import {
  isToolCallJson,
  extractToolCallsFromResponse,
  stripToolCallsFromResponse,
} from '../../src/api/tool-parser.js';

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

  it('rejects name that is not a string', () => {
    expect(isToolCallJson({ name: 42, arguments: {} })).toBe(false);
  });
});

describe('extractToolCallsFromResponse', () => {
  it('extracts from code fence with json tag', () => {
    const text = 'Result:\n```json\n{"name":"get_weather","arguments":{"city":"Paris"}}\n```';
    const result = extractToolCallsFromResponse(text);

    expect(result).not.toBeNull();
    // Code fence and raw JSON patterns may both match the same content
    expect(result!.some(tc => tc.name === 'get_weather')).toBe(true);
    expect(result![0].arguments).toEqual({ city: 'Paris' });
  });

  it('extracts from code fence without json tag', () => {
    const text = '```\n{"name":"search","arguments":{"q":"test"}}\n```';
    const result = extractToolCallsFromResponse(text);

    expect(result).not.toBeNull();
    expect(result![0].name).toBe('search');
  });

  it('extracts from <pre> tag', () => {
    const text = '<pre>{"name":"legacy_tool","arguments":{"x":1}}</pre>';
    const result = extractToolCallsFromResponse(text);

    expect(result).not.toBeNull();
    expect(result![0].name).toBe('legacy_tool');
  });

  it('extracts multiple tool calls', () => {
    const text = '```json\n{"name":"tool1","arguments":{"a":1}}\n```\nThen:\n```json\n{"name":"tool2","arguments":{"b":2}}\n```';
    const result = extractToolCallsFromResponse(text);

    expect(result).not.toBeNull();
    // Both tool calls should be found (may have duplicates from overlapping patterns)
    const names = result!.map(tc => tc.name);
    expect(names).toContain('tool1');
    expect(names).toContain('tool2');
  });

  it('returns null for regular text', () => {
    expect(extractToolCallsFromResponse('Just some text')).toBeNull();
  });

  it('returns null for non-tool JSON in code block', () => {
    const text = '```json\n{"foo":"bar"}\n```';
    expect(extractToolCallsFromResponse(text)).toBeNull();
  });

  it('handles nested arguments', () => {
    const text = '```json\n{"name":"complex","arguments":{"nested":{"deep":true}}}\n```';
    const result = extractToolCallsFromResponse(text);

    expect(result).not.toBeNull();
    expect(result![0].arguments).toEqual({ nested: { deep: true } });
  });
});

describe('stripToolCallsFromResponse', () => {
  it('strips code fence tool calls', () => {
    const text = 'Before\n```json\n{"name":"tool1","arguments":{"a":1}}\n```\nAfter';
    const toolCalls = [{ name: 'tool1', arguments: { a: 1 } }];
    const result = stripToolCallsFromResponse(text, toolCalls);

    expect(result).toContain('Before');
    expect(result).toContain('After');
    expect(result).not.toContain('tool1');
  });

  it('strips <pre> tag tool calls', () => {
    const text = 'Before <pre>{"name":"tool1","arguments":{}}</pre> After';
    const toolCalls = [{ name: 'tool1', arguments: {} }];
    const result = stripToolCallsFromResponse(text, toolCalls);

    expect(result).not.toContain('<pre>');
  });

  it('preserves non-tool code blocks', () => {
    const text = '```json\n{"config":"value"}\n```';
    const result = stripToolCallsFromResponse(text, []);

    expect(result).toContain('config');
  });

  it('returns text unchanged for empty toolCalls', () => {
    const text = 'Some text here';
    expect(stripToolCallsFromResponse(text, [])).toBe(text);
  });
});
