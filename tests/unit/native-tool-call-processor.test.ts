/**
 * Unit tests for NativeToolCallProcessor
 */

import { describe, it, expect } from 'vitest';
import { NativeToolCallProcessor } from '../../src/api/tools/native-tool-call-processor.js';

describe('NativeToolCallProcessor', () => {
  describe('feedToolCall parsing', () => {
    it('parses standard Lumo format with parameters key', () => {
      const processor = new NativeToolCallProcessor();

      processor.feedToolCall('{"name":"web_search","parameters":{"query":"test search"}}');
      processor.finalize();

      const result = processor.getResult();
      expect(result.toolCall).toEqual({
        name: 'web_search',
        arguments: { query: 'test search' },
      });
    });

    it('parses format with arguments key', () => {
      const processor = new NativeToolCallProcessor();

      processor.feedToolCall('{"name":"weather","arguments":{"location":{"city":"Paris"}}}');
      processor.finalize();

      const result = processor.getResult();
      expect(result.toolCall).toEqual({
        name: 'weather',
        arguments: { location: { city: 'Paris' } },
      });
    });

    it('handles Lumo internal format quirk with nested parameters', () => {
      // This is the malformed format observed in production where Lumo sends
      // arguments containing {arguments, name, parameters} instead of just the params
      const processor = new NativeToolCallProcessor();

      const malformedJson = JSON.stringify({
        name: 'web_search',
        arguments: {
          arguments: null,
          name: null,
          parameters: { query: 'latest news Germany' },
        },
      });

      processor.feedToolCall(malformedJson);
      processor.finalize();

      const result = processor.getResult();
      expect(result.toolCall).toEqual({
        name: 'web_search',
        arguments: { query: 'latest news Germany' },
      });
    });

    it('handles streaming JSON across multiple chunks', () => {
      const processor = new NativeToolCallProcessor();

      processor.feedToolCall('{"name":"web_');
      processor.feedToolCall('search","para');
      processor.feedToolCall('meters":{"query":"test"}}');
      processor.finalize();

      const result = processor.getResult();
      expect(result.toolCall).toEqual({
        name: 'web_search',
        arguments: { query: 'test' },
      });
    });
  });

  describe('feedToolResult', () => {
    it('captures tool result JSON', () => {
      const processor = new NativeToolCallProcessor();

      processor.feedToolCall('{"name":"web_search","parameters":{"query":"test"}}');
      processor.feedToolResult('{"results":[{"title":"Test"}],"total_count":1}');
      processor.finalize();

      const result = processor.getResult();
      expect(result.toolResult).toBe('{"results":[{"title":"Test"}],"total_count":1}');
    });

    it('detects error results', () => {
      const processor = new NativeToolCallProcessor();

      processor.feedToolCall('{"name":"web_search","parameters":{"query":"test"}}');
      processor.feedToolResult('{"error":true}');
      processor.finalize();

      const result = processor.getResult();
      expect(result.failed).toBe(true);
    });

    it('reports success for valid results', () => {
      const processor = new NativeToolCallProcessor();

      processor.feedToolCall('{"name":"web_search","parameters":{"query":"test"}}');
      processor.feedToolResult('{"results":[]}');
      processor.finalize();

      const result = processor.getResult();
      expect(result.failed).toBe(false);
    });
  });

  describe('misrouted detection', () => {
    it('detects custom tools routed through native pipeline', () => {
      const processor = new NativeToolCallProcessor();

      // 'my_custom_tool' is not in KNOWN_NATIVE_TOOLS
      const shouldAbort = processor.feedToolCall('{"name":"my_custom_tool","parameters":{}}');
      processor.finalize();

      expect(shouldAbort).toBe(true);
      expect(processor.getResult().misrouted).toBe(true);
    });

    it('does not flag known native tools as misrouted', () => {
      const processor = new NativeToolCallProcessor();

      const shouldAbort = processor.feedToolCall('{"name":"web_search","parameters":{"query":"test"}}');
      processor.finalize();

      expect(shouldAbort).toBe(false);
      expect(processor.getResult().misrouted).toBe(false);
    });

    it('does not flag misrouted in bounce mode', () => {
      const processor = new NativeToolCallProcessor(true); // isBounce = true

      const shouldAbort = processor.feedToolCall('{"name":"my_custom_tool","parameters":{}}');
      processor.finalize();

      expect(shouldAbort).toBe(false);
      expect(processor.getResult().misrouted).toBe(false);
    });
  });
});
