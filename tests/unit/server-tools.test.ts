/**
 * Tests for ServerTools - server-side tools callable by Lumo
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerServerTool,
  getServerTool,
  isServerTool,
  getAllServerToolDefinitions,
  clearServerTools,
  type ServerTool,
  type ServerToolContext,
} from '../../src/api/tools/server-tools/registry.js';
import { executeServerTool } from '../../src/api/tools/server-tools/executor.js';

describe('ServerTool Registry', () => {
  beforeEach(() => {
    clearServerTools();
  });

  describe('registerServerTool', () => {
    it('registers a tool successfully', () => {
      const tool: ServerTool = {
        definition: {
          type: 'function',
          function: {
            name: 'test_tool',
            description: 'A test tool',
            parameters: { type: 'object', properties: {} },
          },
        },
        handler: async () => 'result',
      };

      registerServerTool(tool);
      expect(getServerTool('test_tool')).toBe(tool);
    });

    it('throws when registering duplicate tool', () => {
      const tool: ServerTool = {
        definition: {
          type: 'function',
          function: {
            name: 'test_tool',
            description: 'A test tool',
            parameters: {},
          },
        },
        handler: async () => 'result',
      };

      registerServerTool(tool);
      expect(() => registerServerTool(tool)).toThrow(
        'ServerTool "test_tool" is already registered'
      );
    });
  });

  describe('getServerTool', () => {
    it('returns undefined for unregistered tool', () => {
      expect(getServerTool('nonexistent')).toBeUndefined();
    });

    it('returns registered tool', () => {
      const tool: ServerTool = {
        definition: {
          type: 'function',
          function: {
            name: 'my_tool',
            description: 'My tool',
            parameters: {},
          },
        },
        handler: async () => 'ok',
      };

      registerServerTool(tool);
      expect(getServerTool('my_tool')).toBe(tool);
    });
  });

  describe('isServerTool', () => {
    it('returns false for unregistered tool', () => {
      expect(isServerTool('nonexistent')).toBe(false);
    });

    it('returns true for registered tool', () => {
      registerServerTool({
        definition: {
          type: 'function',
          function: { name: 'exists', description: '', parameters: {} },
        },
        handler: async () => '',
      });
      expect(isServerTool('exists')).toBe(true);
    });
  });

  describe('getAllServerToolDefinitions', () => {
    it('returns empty array when no tools registered', () => {
      expect(getAllServerToolDefinitions()).toEqual([]);
    });

    it('returns all registered tool definitions', () => {
      const tool1: ServerTool = {
        definition: {
          type: 'function',
          function: { name: 'tool1', description: 'Tool 1', parameters: {} },
        },
        handler: async () => '1',
      };
      const tool2: ServerTool = {
        definition: {
          type: 'function',
          function: { name: 'tool2', description: 'Tool 2', parameters: {} },
        },
        handler: async () => '2',
      };

      registerServerTool(tool1);
      registerServerTool(tool2);

      const defs = getAllServerToolDefinitions();
      expect(defs).toHaveLength(2);
      expect(defs.map(d => d.function.name)).toContain('tool1');
      expect(defs.map(d => d.function.name)).toContain('tool2');
    });
  });
});

describe('ServerTool Executor', () => {
  beforeEach(() => {
    clearServerTools();
  });

  it('returns isServerTool: false for unregistered tool', async () => {
    const result = await executeServerTool('nonexistent', {}, {});
    expect(result.isServerTool).toBe(false);
    expect(result.result).toBeUndefined();
    expect(result.error).toBeUndefined();
  });

  it('executes tool and returns result', async () => {
    registerServerTool({
      definition: {
        type: 'function',
        function: { name: 'echo', description: '', parameters: {} },
      },
      handler: async (args: Record<string, unknown>) => `echoed: ${args.message}`,
    });

    const result = await executeServerTool('echo', { message: 'hello' }, {});
    expect(result.isServerTool).toBe(true);
    expect(result.result).toBe('echoed: hello');
    expect(result.error).toBeUndefined();
  });

  it('returns error when handler throws', async () => {
    registerServerTool({
      definition: {
        type: 'function',
        function: { name: 'failing', description: '', parameters: {} },
      },
      handler: async () => {
        throw new Error('Something went wrong');
      },
    });

    const result = await executeServerTool('failing', {}, {});
    expect(result.isServerTool).toBe(true);
    expect(result.result).toBeUndefined();
    expect(result.error).toBe('Something went wrong');
  });

  it('passes context to handler', async () => {
    let receivedCtx: ServerToolContext | undefined;

    registerServerTool({
      definition: {
        type: 'function',
        function: { name: 'ctx_test', description: '', parameters: {} },
      },
      handler: async (_args: Record<string, unknown>, context: ServerToolContext) => {
        receivedCtx = context;
        return 'ok';
      },
    });

    const context: ServerToolContext = {
      conversationId: 'conv-123' as any,
    };

    await executeServerTool('ctx_test', {}, context);
    expect(receivedCtx?.conversationId).toBe('conv-123');
  });
});
