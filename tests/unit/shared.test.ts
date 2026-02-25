/**
 * Unit tests for shared route utilities
 *
 * Tests ID generators, accumulating tool processor, and persistence helpers.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  generateResponseId,
  generateItemId,
  generateFunctionCallId,
  generateChatCompletionId,
  persistAssistantTurn,
} from '../../src/api/routes/shared.js';
import { generateCallId, extractToolNameFromCallId } from '../../src/api/tools/call-id.js';
import { createAccumulatingToolProcessor } from '../../src/api/tools/streaming-processor.js';
import type { EndpointDependencies } from '../../src/api/types.js';

describe('ID generators', () => {
  it('generateResponseId returns resp-{uuid} format', () => {
    const id = generateResponseId();
    expect(id).toMatch(/^resp-[0-9a-f-]{36}$/);
  });

  it('generateItemId returns item-{uuid} format', () => {
    const id = generateItemId();
    expect(id).toMatch(/^item-[0-9a-f-]{36}$/);
  });

  it('generateFunctionCallId returns fc-{uuid} format', () => {
    const id = generateFunctionCallId();
    expect(id).toMatch(/^fc-[0-9a-f-]{36}$/);
  });

  it('generateCallId returns toolname__{24-char-hex} format', () => {
    const id = generateCallId('my_tool');
    expect(id).toMatch(/^my_tool__[0-9a-f]{24}$/);
  });

  it('extractToolNameFromCallId extracts tool name from call_id', () => {
    expect(extractToolNameFromCallId('my_tool__abc123def456789012345678')).toBe('my_tool');
    expect(extractToolNameFromCallId('search__0123456789abcdef01234567')).toBe('search');
    expect(extractToolNameFromCallId('invalid_format')).toBeUndefined();
    expect(extractToolNameFromCallId('call_abc123')).toBeUndefined();
  });

  it('generateChatCompletionId returns chatcmpl-{uuid} format', () => {
    const id = generateChatCompletionId();
    expect(id).toMatch(/^chatcmpl-[0-9a-f-]{36}$/);
  });

  it('generates unique IDs', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateResponseId()));
    expect(ids.size).toBe(100);
  });
});

describe('createAccumulatingToolProcessor', () => {
  it('accumulates text when hasCustomTools is false', () => {
    const { processor, getAccumulatedText } = createAccumulatingToolProcessor(false);

    processor.onChunk('Hello ');
    processor.onChunk('world');
    processor.finalize();

    expect(getAccumulatedText()).toBe('Hello world');
    expect(processor.toolCallsEmitted).toEqual([]);
  });

  it('extracts and strips tool calls when hasCustomTools is true', () => {
    const { processor, getAccumulatedText } = createAccumulatingToolProcessor(true);

    processor.onChunk('Result:\n```json\n{"name":"search","arguments":{"q":"test"}}\n```\nDone.');
    processor.finalize();

    expect(processor.toolCallsEmitted.length).toBe(1);
    expect(processor.toolCallsEmitted[0].function.name).toBe('search');
    expect(processor.toolCallsEmitted[0].function.arguments).toBe('{"q":"test"}');
    expect(getAccumulatedText()).toContain('Result:');
    expect(getAccumulatedText()).toContain('Done.');
    expect(getAccumulatedText()).not.toContain('```json');
  });

  it('returns empty toolCallsEmitted when no tools found', () => {
    const { processor, getAccumulatedText } = createAccumulatingToolProcessor(true);

    processor.onChunk('Just plain text');
    processor.finalize();

    expect(processor.toolCallsEmitted).toEqual([]);
    expect(getAccumulatedText()).toBe('Just plain text');
  });
});

describe('persistAssistantTurn', () => {
  interface PersistedMessage {
    content: string;
    toolCall?: string;
    toolResult?: string;
  }

  function createMockDeps(): EndpointDependencies & {
    persistedMessages: PersistedMessage[];
  } {
    const persistedMessages: PersistedMessage[] = [];
    return {
      persistedMessages,
      queue: {} as any,
      lumoClient: {} as any,
      conversationStore: {
        appendAssistantResponse: vi.fn(
          (_id: string, messageData: { content: string; toolCall?: string; toolResult?: string }) => {
            persistedMessages.push(messageData);
          }
        ),
      } as any,
    };
  }

  it('persists content when no tool calls', () => {
    const deps = createMockDeps();
    persistAssistantTurn(deps, 'conv-123', { content: 'Hello world' }, undefined);

    expect(deps.persistedMessages).toHaveLength(1);
    expect(deps.persistedMessages[0].content).toBe('Hello world');
    expect(deps.persistedMessages[0].toolCall).toBeUndefined();
  });

  it('skips persistence when custom tool calls are present', () => {
    const deps = createMockDeps();
    const toolCalls = [
      { name: 'search', arguments: '{}', call_id: 'call-123' },
    ];

    persistAssistantTurn(deps, 'conv-123', { content: 'Some text' }, toolCalls);

    // Should NOT persist anything - client will send it back
    expect(deps.persistedMessages).toEqual([]);
  });

  it('skips persistence when multiple custom tool calls are present', () => {
    const deps = createMockDeps();
    const toolCalls = [
      { name: 'search', arguments: '{"q":"test"}', call_id: 'call-1' },
      { name: 'weather', arguments: '{"loc":"Paris"}', call_id: 'call-2' },
    ];

    persistAssistantTurn(deps, 'conv-123', { content: 'Let me check that' }, toolCalls);

    expect(deps.persistedMessages).toEqual([]);
  });

  it('does nothing for stateless requests (no conversationId)', () => {
    const deps = createMockDeps();
    persistAssistantTurn(deps, undefined, { content: 'Hello' }, undefined);

    expect(deps.persistedMessages).toEqual([]);
  });

  it('persists native tool call with tool data', () => {
    const deps = createMockDeps();
    const message = {
      content: 'Based on search results...',
      toolCall: '{"name":"web_search","arguments":{"query":"test search"}}',
      toolResult: '{"results":[{"title":"Result"}]}',
    };

    persistAssistantTurn(deps, 'conv-123', message, undefined);

    expect(deps.persistedMessages).toHaveLength(1);
    expect(deps.persistedMessages[0].content).toBe('Based on search results...');
    expect(deps.persistedMessages[0].toolCall).toBe('{"name":"web_search","arguments":{"query":"test search"}}');
    expect(deps.persistedMessages[0].toolResult).toBe('{"results":[{"title":"Result"}]}');
  });

  it('persists native tool call without tool result', () => {
    const deps = createMockDeps();
    const message = {
      content: 'Weather info...',
      toolCall: '{"name":"weather","arguments":{"location":{"city":"Paris"}}}',
      toolResult: undefined,
    };

    persistAssistantTurn(deps, 'conv-123', message, undefined);

    expect(deps.persistedMessages).toHaveLength(1);
    expect(deps.persistedMessages[0].toolCall).toBe('{"name":"weather","arguments":{"location":{"city":"Paris"}}}');
    expect(deps.persistedMessages[0].toolResult).toBeUndefined();
  });

  it('prioritizes custom tool calls over native tool calls', () => {
    const deps = createMockDeps();
    const customToolCalls = [{ name: 'custom_tool', arguments: '{}', call_id: 'call-1' }];
    const message = {
      content: 'Text',
      toolCall: '{"name":"web_search","arguments":{"query":"test"}}',
      toolResult: '{}',
    };

    // Both custom and native present - custom takes precedence (skip persistence)
    persistAssistantTurn(deps, 'conv-123', message, customToolCalls);

    expect(deps.persistedMessages).toEqual([]);
  });
});
