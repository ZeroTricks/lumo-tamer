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
  function createMockDeps(): EndpointDependencies & { appendCalls: string[] } {
    const appendCalls: string[] = [];
    return {
      appendCalls,
      queue: {} as any,
      lumoClient: {} as any,
      conversationStore: {
        appendAssistantResponse: vi.fn((_id: string, content: string) => {
          appendCalls.push(content);
        }),
      } as any,
    };
  }

  it('persists content when no tool calls', () => {
    const deps = createMockDeps();
    persistAssistantTurn(deps, 'conv-123', 'Hello world', undefined);

    expect(deps.appendCalls).toEqual(['Hello world']);
  });

  it('skips persistence when tool calls are present', () => {
    const deps = createMockDeps();
    const toolCalls = [
      { name: 'search', arguments: '{}', call_id: 'call-123' },
    ];

    persistAssistantTurn(deps, 'conv-123', 'Some text', toolCalls);

    // Should NOT persist anything - client will send it back
    expect(deps.appendCalls).toEqual([]);
  });

  it('skips persistence when multiple tool calls are present', () => {
    const deps = createMockDeps();
    const toolCalls = [
      { name: 'search', arguments: '{"q":"test"}', call_id: 'call-1' },
      { name: 'weather', arguments: '{"loc":"Paris"}', call_id: 'call-2' },
    ];

    persistAssistantTurn(deps, 'conv-123', 'Let me check that', toolCalls);

    expect(deps.appendCalls).toEqual([]);
  });

  it('does nothing for stateless requests (no conversationId)', () => {
    const deps = createMockDeps();
    persistAssistantTurn(deps, undefined, 'Hello', undefined);

    expect(deps.appendCalls).toEqual([]);
  });
});
