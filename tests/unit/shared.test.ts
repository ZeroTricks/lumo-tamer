/**
 * Unit tests for shared route utilities
 *
 * Tests ID generators, accumulating tool processor, and persistence helpers.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  generateResponseId,
  generateItemId,
  generateFunctionCallId,
  generateChatCompletionId,
} from '../../src/api/routes/shared.js';
import {
  registerServerTool,
  clearServerTools,
  type ServerToolContext,
} from '../../src/api/tools/server-tools/registry.js';
import {
  partitionToolCalls,
  buildServerToolContinuation,
} from '../../src/api/tools/server-tools/executor.js';
import { Role } from '../../src/lumo-client/types.js';
import { generateCallId, extractToolNameFromCallId } from '../../src/api/tools/call-id.js';
import { createAccumulatingToolProcessor } from '../../src/api/tools/streaming-processor.js';

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

describe('partitionToolCalls', () => {
  beforeEach(() => {
    clearServerTools();
  });

  it('returns empty arrays when no tool calls', () => {
    const result = partitionToolCalls([]);
    expect(result.serverToolCalls).toEqual([]);
    expect(result.customToolCalls).toEqual([]);
  });

  it('partitions tool calls into server and custom tools', () => {
    // Register a server tool
    registerServerTool({
      definition: {
        type: 'function',
        function: { name: 'lumo_search', description: 'Search', parameters: {} },
      },
      handler: async () => 'result',
    });

    const toolCalls = [
      { id: 'call-1', type: 'function' as const, function: { name: 'lumo_search', arguments: '{}' } },
      { id: 'call-2', type: 'function' as const, function: { name: 'custom_tool', arguments: '{}' } },
      { id: 'call-3', type: 'function' as const, function: { name: 'another_custom', arguments: '{}' } },
    ];

    const result = partitionToolCalls(toolCalls);

    expect(result.serverToolCalls).toHaveLength(1);
    expect(result.serverToolCalls[0].function.name).toBe('lumo_search');
    expect(result.customToolCalls).toHaveLength(2);
    expect(result.customToolCalls.map(tc => tc.function.name)).toEqual(['custom_tool', 'another_custom']);
  });

  it('returns all as custom when no server tools registered', () => {
    const toolCalls = [
      { id: 'call-1', type: 'function' as const, function: { name: 'tool1', arguments: '{}' } },
      { id: 'call-2', type: 'function' as const, function: { name: 'tool2', arguments: '{}' } },
    ];

    const result = partitionToolCalls(toolCalls);

    expect(result.serverToolCalls).toEqual([]);
    expect(result.customToolCalls).toHaveLength(2);
  });
});

describe('buildServerToolContinuation', () => {
  beforeEach(() => {
    clearServerTools();
  });

  it('builds continuation turns with assistant message and tool results', async () => {
    // Register a server tool
    registerServerTool({
      definition: {
        type: 'function',
        function: { name: 'lumo_search', description: 'Search', parameters: {} },
      },
      handler: async (args) => `Found results for: ${args.query}`,
    });

    const serverToolCalls = [
      { id: 'call-1', type: 'function' as const, function: { name: 'lumo_search', arguments: '{"query":"test"}' } },
    ];

    const context: ServerToolContext = {};
    const turns = await buildServerToolContinuation(serverToolCalls, 'Assistant text', context, 'user:');

    expect(turns).toHaveLength(2);

    // First turn: assistant message
    expect(turns[0].role).toBe(Role.Assistant);
    expect(turns[0].content).toBe('Assistant text');

    // Second turn: user message with tool result
    expect(turns[1].role).toBe(Role.User);
    expect(turns[1].content).toContain('function_call_output');
    expect(turns[1].content).toContain('call-1');
    expect(turns[1].content).toContain('Found results for: test');
  });

  it('handles multiple server tool calls', async () => {
    registerServerTool({
      definition: {
        type: 'function',
        function: { name: 'tool_a', description: 'A', parameters: {} },
      },
      handler: async () => 'Result A',
    });
    registerServerTool({
      definition: {
        type: 'function',
        function: { name: 'tool_b', description: 'B', parameters: {} },
      },
      handler: async () => 'Result B',
    });

    const serverToolCalls = [
      { id: 'call-a', type: 'function' as const, function: { name: 'tool_a', arguments: '{}' } },
      { id: 'call-b', type: 'function' as const, function: { name: 'tool_b', arguments: '{}' } },
    ];

    const turns = await buildServerToolContinuation(serverToolCalls, 'Text', {}, 'prefix:');

    // 1 assistant + 2 user turns
    expect(turns).toHaveLength(3);
    expect(turns[0].role).toBe(Role.Assistant);
    expect(turns[1].role).toBe(Role.User);
    expect(turns[2].role).toBe(Role.User);

    expect(turns[1].content).toContain('Result A');
    expect(turns[2].content).toContain('Result B');
  });

  it('includes error message when tool execution fails', async () => {
    registerServerTool({
      definition: {
        type: 'function',
        function: { name: 'failing_tool', description: 'Fails', parameters: {} },
      },
      handler: async () => {
        throw new Error('Something went wrong');
      },
    });

    const serverToolCalls = [
      { id: 'call-fail', type: 'function' as const, function: { name: 'failing_tool', arguments: '{}' } },
    ];

    const turns = await buildServerToolContinuation(serverToolCalls, 'Text', {}, 'user:');

    expect(turns).toHaveLength(2);
    expect(turns[1].content).toContain('Error executing failing_tool');
    expect(turns[1].content).toContain('Something went wrong');
  });

  it('includes prefix in tool_name field', async () => {
    registerServerTool({
      definition: {
        type: 'function',
        function: { name: 'my_tool', description: 'My tool', parameters: {} },
      },
      handler: async () => 'ok',
    });

    const serverToolCalls = [
      { id: 'call-1', type: 'function' as const, function: { name: 'my_tool', arguments: '{}' } },
    ];

    const turns = await buildServerToolContinuation(serverToolCalls, 'Text', {}, 'custom:');

    const content = turns[1].content;
    expect(content).toContain('"tool_name":"custom:my_tool"');
  });
});
