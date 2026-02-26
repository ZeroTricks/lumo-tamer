/**
 * Unit tests for message-converter
 *
 * Tests conversion from OpenAI message formats to Lumo Turn format.
 * Note: Instruction injection is now handled by LumoClient, not message-converter.
 * These tests verify that message-converter returns clean turns without instructions.
 */

import { describe, it, expect } from 'vitest';
import { convertChatMessages, convertResponseInput, convertToolMessage } from '../../src/api/message-converter.js';

describe('convertChatMessages', () => {
  it('converts user and assistant messages', () => {
    const turns = convertChatMessages([
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi!' },
    ]);

    expect(turns).toHaveLength(2);
    expect(turns[0].role).toBe('user');
    expect(turns[0].content).toBe('Hello');
    expect(turns[1].role).toBe('assistant');
    expect(turns[1].content).toBe('Hi!');
  });

  it('skips system messages from output', () => {
    const turns = convertChatMessages([
      { role: 'system', content: 'Be helpful' },
      { role: 'user', content: 'Hello' },
    ]);

    // System message is skipped, not injected (injection happens in LumoClient)
    expect(turns).toHaveLength(1);
    expect(turns[0].role).toBe('user');
    expect(turns[0].content).toBe('Hello');
  });

  it('returns clean turns without instruction injection', () => {
    const turns = convertChatMessages([
      { role: 'system', content: 'Be concise' },
      { role: 'user', content: 'Hello' },
    ]);

    // No instruction injection - that happens in LumoClient
    expect(turns[0].content).toBe('Hello');
    expect(turns[0].content).not.toContain('[Project instructions:');
  });

  it('handles multi-turn conversations', () => {
    const turns = convertChatMessages([
      { role: 'system', content: 'Be concise' },
      { role: 'user', content: 'First message' },
      { role: 'assistant', content: 'Response' },
      { role: 'user', content: 'Second message' },
    ]);

    expect(turns).toHaveLength(3);
    expect(turns[0].content).toBe('First message');
    expect(turns[1].content).toBe('Response');
    expect(turns[2].content).toBe('Second message');
  });

  it('preserves command messages unchanged', () => {
    const turns = convertChatMessages([
      { role: 'system', content: 'Instructions' },
      { role: 'user', content: '/help' },
    ]);

    expect(turns[0].content).toBe('/help');
  });

  it('handles empty messages array', () => {
    const turns = convertChatMessages([]);
    expect(turns).toEqual([]);
  });
});

describe('convertResponseInput', () => {
  it('handles string input', () => {
    const turns = convertResponseInput('Hello');

    expect(turns).toHaveLength(1);
    expect(turns[0].role).toBe('user');
    expect(turns[0].content).toBe('Hello');
  });

  it('returns clean turns for string input (no instruction injection)', () => {
    const turns = convertResponseInput('Hello', 'Be concise');

    expect(turns).toHaveLength(1);
    expect(turns[0].content).toBe('Hello');
    expect(turns[0].content).not.toContain('[Project instructions:');
  });

  it('handles message array input', () => {
    const turns = convertResponseInput([
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi!' },
    ]);

    expect(turns).toHaveLength(2);
    expect(turns[0].role).toBe('user');
    expect(turns[0].content).toBe('Hello');
    expect(turns[1].role).toBe('assistant');
    expect(turns[1].content).toBe('Hi!');
  });

  it('skips system messages from output', () => {
    const turns = convertResponseInput([
      { role: 'system', content: 'Custom system instructions here' },
      { role: 'user', content: 'Hello' },
    ]);

    // System message is skipped
    expect(turns).toHaveLength(1);
    expect(turns[0].content).toBe('Hello');
  });

  it('handles function_call_output items', () => {
    const turns = convertResponseInput([
      { role: 'user', content: 'Call a tool' },
      { type: 'function_call_output', call_id: 'call_1', output: 'result' } as any,
      { role: 'user', content: 'Follow up' },
    ]);

    // function_call_output should be converted to user turn with fenced JSON
    expect(turns).toHaveLength(3);
    expect(turns[0].content).toBe('Call a tool');
    expect(turns[1].role).toBe('user');
    expect(turns[1].content).toContain('```json');
    expect(turns[2].content).toBe('Follow up');
  });

  it('returns empty array for undefined input', () => {
    expect(convertResponseInput(undefined)).toEqual([]);
  });

  it('preserves command strings unchanged', () => {
    const turns = convertResponseInput('/save');

    expect(turns).toHaveLength(1);
    expect(turns[0].content).toBe('/save');
  });
});

describe('convertToolMessage', () => {
  it('normalizes role: "tool" message to user with fenced JSON content', () => {
    const result = convertToolMessage({
      role: 'tool',
      tool_call_id: 'call_abc123',
      content: 'Tool output here',
    });

    expect(result).not.toBeNull();
    expect(Array.isArray(result)).toBe(false);
    const normalized = result as { role: string; content: string };
    expect(normalized.role).toBe('user');
    // Content should be fenced JSON
    expect(normalized.content).toMatch(/^```json\n.*\n```$/s);
    // Extract and parse the JSON inside the fence
    const jsonMatch = normalized.content.match(/```json\n(.*)\n```/s);
    expect(jsonMatch).not.toBeNull();
    const parsed = JSON.parse(jsonMatch![1]);
    expect(parsed.type).toBe('function_call_output');
    expect(parsed.call_id).toBe('call_abc123');
    expect(parsed.output).toBe('Tool output here');
  });

  it('normalizes assistant with tool_calls to array of assistant messages', () => {
    const result = convertToolMessage({
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
    const result = convertToolMessage({
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
    const result = convertToolMessage({
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

  it('normalizes function_call_output (Responses API) to user with fenced JSON', () => {
    const result = convertToolMessage({
      type: 'function_call_output',
      call_id: 'call_xyz',
      output: 'Search results here',
    });

    expect(result).not.toBeNull();
    expect(Array.isArray(result)).toBe(false);
    const normalized = result as { role: string; content: string };
    expect(normalized.role).toBe('user');
    // Content should be fenced JSON
    expect(normalized.content).toMatch(/^```json\n.*\n```$/s);
    // Extract and parse the JSON inside the fence
    const jsonMatch = normalized.content.match(/```json\n(.*)\n```/s);
    expect(jsonMatch).not.toBeNull();
    const parsed = JSON.parse(jsonMatch![1]);
    expect(parsed.type).toBe('function_call_output');
    expect(parsed.call_id).toBe('call_xyz');
    expect(parsed.output).toBe('Search results here');
  });

  it('returns null for regular messages (no normalization needed)', () => {
    expect(convertToolMessage({ role: 'user', content: 'Hello' })).toBeNull();
    expect(convertToolMessage({ role: 'assistant', content: 'Hi!' })).toBeNull();
    expect(convertToolMessage({ role: 'system', content: 'Be helpful' })).toBeNull();
  });

  it('returns null for invalid inputs', () => {
    expect(convertToolMessage(null)).toBeNull();
    expect(convertToolMessage(undefined)).toBeNull();
    expect(convertToolMessage('string')).toBeNull();
    expect(convertToolMessage(123)).toBeNull();
  });
});

describe('convertChatMessages with tool messages', () => {
  it('converts role: "tool" message to user turn with fenced JSON', () => {
    const turns = convertChatMessages([
      { role: 'user', content: 'Call a tool' },
      { role: 'tool', tool_call_id: 'call_abc', content: 'Tool result' } as any,
    ]);

    expect(turns).toHaveLength(2);
    expect(turns[0].role).toBe('user');
    expect(turns[0].content).toBe('Call a tool');
    // Tool message is converted to user turn with fenced JSON
    expect(turns[1].role).toBe('user');
    expect(turns[1].content).toContain('```json\n');
    expect(turns[1].content).toContain('"type":"function_call_output"');
    expect(turns[1].content).toContain('"call_id":"call_abc"');
  });

  it('converts assistant with tool_calls to assistant turns with JSON', () => {
    const turns = convertChatMessages([
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
    expect(turns[0].content).toBe('Get the weather');
    expect(turns[1].role).toBe('assistant');
    const parsed = JSON.parse(turns[1].content);
    expect(parsed.type).toBe('function_call');
    expect(parsed.call_id).toBe('call_1');
    expect(parsed.name).toBe('get_weather');
  });

  it('handles full tool call conversation flow', () => {
    const turns = convertChatMessages([
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
    expect(turns[0].content).toBe('What is the weather in NYC?');
    expect(turns[1].role).toBe('assistant'); // tool_calls
    expect(turns[2].role).toBe('user'); // tool result
    expect(turns[3].role).toBe('assistant'); // final response
    expect(turns[3].content).toBe('The weather in NYC is sunny and 72F.');
  });
});
