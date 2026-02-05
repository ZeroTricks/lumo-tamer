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
import { convertMessagesToTurns, convertResponseInputToTurns } from '../../src/api/message-converter.js';

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
      { role: 'system', content: 'System instructions' },
      { role: 'user', content: 'Hello' },
    ]);

    // System message extracted, injected into user message
    expect(turns).toHaveLength(1);
    expect(turns[0].content).toContain('System instructions');
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
