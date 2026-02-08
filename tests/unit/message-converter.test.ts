/**
 * Unit tests for message-converter
 *
 * Tests conversion from OpenAI message formats to Lumo Turn format,
 * including instruction injection and system message handling.
 *
 * Note: These tests use the default config from config.defaults.yaml.
 * The default instructions and append behavior affect the output.
 */

import { describe, it, expect } from 'vitest';
import { convertMessagesToTurns, convertResponseInputToTurns, normalizeInputItem } from '../../src/api/message-converter.js';

describe('convertMessagesToTurns', () => {
  it('converts user and assistant messages', () => {
    const turns = convertMessagesToTurns([
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi!' },
    ]);

    expect(turns).toHaveLength(2);
    expect(turns[0].role).toBe('user');
    expect(turns[1].role).toBe('assistant');
    expect(turns[1].content).toBe('Hi!');
  });

  it('skips system messages from output (used as instructions)', () => {
    const turns = convertMessagesToTurns([
      { role: 'system', content: 'Be helpful' },
      { role: 'user', content: 'Hello' },
    ]);

    // System message is extracted and injected as [Personal context: ...]
    expect(turns).toHaveLength(1);
    expect(turns[0].role).toBe('user');
  });

  it('injects instructions into first user message', () => {
    const turns = convertMessagesToTurns([
      { role: 'system', content: 'Be concise' },
      { role: 'user', content: 'Hello' },
    ]);

    // Instructions should be appended as [Personal context: ...]
    expect(turns[0].content).toContain('[Personal context:');
    expect(turns[0].content).toContain('Be concise');
  });

  it('does not inject instructions into command messages', () => {
    const turns = convertMessagesToTurns([
      { role: 'system', content: 'Instructions' },
      { role: 'user', content: '/help' },
    ]);

    // Commands (starting with /) should not get instructions injected
    expect(turns[0].content).toBe('/help');
  });

  it('handles empty messages array', () => {
    const turns = convertMessagesToTurns([]);
    expect(turns).toEqual([]);
  });
});

describe('convertResponseInputToTurns', () => {
  it('handles string input', () => {
    const turns = convertResponseInputToTurns('Hello');

    expect(turns).toHaveLength(1);
    expect(turns[0].role).toBe('user');
    expect(turns[0].content).toContain('Hello');
  });

  it('handles string input with request instructions', () => {
    const turns = convertResponseInputToTurns('Hello', 'Be concise');

    expect(turns).toHaveLength(1);
    expect(turns[0].content).toContain('Hello');
    expect(turns[0].content).toContain('Be concise');
  });

  it('handles message array input', () => {
    const turns = convertResponseInputToTurns([
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi!' },
    ]);

    expect(turns).toHaveLength(2);
    expect(turns[0].role).toBe('user');
    expect(turns[1].role).toBe('assistant');
  });

  it('handles message array with system message', () => {
    const turns = convertResponseInputToTurns([
      { role: 'system', content: 'Custom system instructions here' },
      { role: 'user', content: 'Hello' },
    ]);

    // System message extracted and used as clientInstructions in template
    expect(turns).toHaveLength(1);
    expect(turns[0].content).toContain('Custom system instructions here');
  });

  it('filters out function_call_output items', () => {
    const turns = convertResponseInputToTurns([
      { role: 'user', content: 'Call a tool' },
      { type: 'function_call_output', call_id: 'call_1', output: 'result' } as any,
      { role: 'user', content: 'Follow up' },
    ]);

    // function_call_output should be filtered
    const contents = turns.map(t => t.content);
    expect(contents).not.toContain('result');
  });

  it('returns empty array for undefined input', () => {
    expect(convertResponseInputToTurns(undefined)).toEqual([]);
  });

  it('does not inject instructions into command strings', () => {
    const turns = convertResponseInputToTurns('/save');

    expect(turns).toHaveLength(1);
    expect(turns[0].content).toBe('/save');
  });
});

describe('normalizeInputItem', () => {
  it('normalizes role: "tool" message to user with JSON content', () => {
    const result = normalizeInputItem({
      role: 'tool',
      tool_call_id: 'call_abc123',
      content: 'Tool output here',
    });

    expect(result).not.toBeNull();
    expect(Array.isArray(result)).toBe(false);
    const normalized = result as { role: string; content: string };
    expect(normalized.role).toBe('user');
    const parsed = JSON.parse(normalized.content);
    expect(parsed.type).toBe('function_call_output');
    expect(parsed.call_id).toBe('call_abc123');
    expect(parsed.output).toBe('Tool output here');
  });

  it('normalizes assistant with tool_calls to array of assistant messages', () => {
    const result = normalizeInputItem({
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"NYC"}' } },
        { id: 'call_2', type: 'function', function: { name: 'get_time', arguments: '{}' } },
      ],
    });

    expect(result).not.toBeNull();
    expect(Array.isArray(result)).toBe(true);
    const normalizedArray = result as Array<{ role: string; content: string }>;
    expect(normalizedArray).toHaveLength(2);

    expect(normalizedArray[0].role).toBe('assistant');
    const parsed1 = JSON.parse(normalizedArray[0].content);
    expect(parsed1.type).toBe('function_call');
    expect(parsed1.call_id).toBe('call_1');
    expect(parsed1.name).toBe('get_weather');

    expect(normalizedArray[1].role).toBe('assistant');
    const parsed2 = JSON.parse(normalizedArray[1].content);
    expect(parsed2.call_id).toBe('call_2');
    expect(parsed2.name).toBe('get_time');
  });

  it('normalizes function_call (Responses API) to assistant with JSON', () => {
    const result = normalizeInputItem({
      type: 'function_call',
      call_id: 'call_xyz',
      name: 'search',
      arguments: '{"query":"test"}',
    });

    expect(result).not.toBeNull();
    expect(Array.isArray(result)).toBe(false);
    const normalized = result as { role: string; content: string };
    expect(normalized.role).toBe('assistant');
    const parsed = JSON.parse(normalized.content);
    expect(parsed.type).toBe('function_call');
    expect(parsed.call_id).toBe('call_xyz');
    expect(parsed.name).toBe('search');
    // Arguments should be kept as string
    expect(typeof parsed.arguments).toBe('string');
    expect(parsed.arguments).toBe('{"query":"test"}');
  });

  it('normalizes function_call with object arguments to string', () => {
    // Some clients send arguments as objects instead of strings
    const result = normalizeInputItem({
      type: 'function_call',
      call_id: 'call_xyz',
      name: 'search',
      arguments: { query: 'test' }, // Object instead of string
    });

    expect(result).not.toBeNull();
    const normalized = result as { role: string; content: string };
    const parsed = JSON.parse(normalized.content);
    // Arguments should be stringified for consistent hashing
    expect(typeof parsed.arguments).toBe('string');
    expect(JSON.parse(parsed.arguments)).toEqual({ query: 'test' });
  });

  it('normalizes function_call_output (Responses API) to user with JSON', () => {
    const result = normalizeInputItem({
      type: 'function_call_output',
      call_id: 'call_xyz',
      output: 'Search results here',
    });

    expect(result).not.toBeNull();
    expect(Array.isArray(result)).toBe(false);
    const normalized = result as { role: string; content: string };
    expect(normalized.role).toBe('user');
    const parsed = JSON.parse(normalized.content);
    expect(parsed.type).toBe('function_call_output');
    expect(parsed.call_id).toBe('call_xyz');
    expect(parsed.output).toBe('Search results here');
  });

  it('returns null for regular messages (no normalization needed)', () => {
    expect(normalizeInputItem({ role: 'user', content: 'Hello' })).toBeNull();
    expect(normalizeInputItem({ role: 'assistant', content: 'Hi!' })).toBeNull();
    expect(normalizeInputItem({ role: 'system', content: 'Be helpful' })).toBeNull();
  });

  it('returns null for invalid inputs', () => {
    expect(normalizeInputItem(null)).toBeNull();
    expect(normalizeInputItem(undefined)).toBeNull();
    expect(normalizeInputItem('string')).toBeNull();
    expect(normalizeInputItem(123)).toBeNull();
  });
});

describe('convertMessagesToTurns with tool messages', () => {
  it('converts role: "tool" message to user turn with JSON', () => {
    const turns = convertMessagesToTurns([
      { role: 'user', content: 'Call a tool' },
      { role: 'tool', tool_call_id: 'call_abc', content: 'Tool result' } as any,
    ]);

    expect(turns).toHaveLength(2);
    expect(turns[0].role).toBe('user');
    expect(turns[1].role).toBe('user'); // tool -> user
    const parsed = JSON.parse(turns[1].content);
    expect(parsed.type).toBe('function_call_output');
    expect(parsed.call_id).toBe('call_abc');
    expect(parsed.output).toBe('Tool result');
  });

  it('converts assistant with tool_calls to assistant turns with JSON', () => {
    const turns = convertMessagesToTurns([
      { role: 'user', content: 'Get the weather' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"NYC"}' } },
        ],
      } as any,
    ]);

    expect(turns).toHaveLength(2);
    expect(turns[0].role).toBe('user');
    expect(turns[1].role).toBe('assistant');
    const parsed = JSON.parse(turns[1].content);
    expect(parsed.type).toBe('function_call');
    expect(parsed.call_id).toBe('call_1');
    expect(parsed.name).toBe('get_weather');
  });

  it('handles full tool call conversation flow', () => {
    const turns = convertMessagesToTurns([
      { role: 'user', content: 'What is the weather in NYC?' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_weather', type: 'function', function: { name: 'get_weather', arguments: '{"city":"NYC"}' } },
        ],
      } as any,
      { role: 'tool', tool_call_id: 'call_weather', content: 'Sunny, 72F' } as any,
      { role: 'assistant', content: 'The weather in NYC is sunny and 72F.' },
    ]);

    expect(turns).toHaveLength(4);
    expect(turns[0].role).toBe('user');
    expect(turns[1].role).toBe('assistant'); // tool_calls
    expect(turns[2].role).toBe('user'); // tool result
    expect(turns[3].role).toBe('assistant'); // final response
    expect(turns[3].content).toBe('The weather in NYC is sunny and 72F.');
  });
});
