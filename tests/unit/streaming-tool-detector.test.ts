/**
 * Unit tests for StreamingToolDetector
 *
 * Tests the state machine that detects JSON tool calls in streaming text,
 * supporting both code fence (```json) and raw JSON formats.
 */

import { describe, it, expect } from 'vitest';
import { StreamingToolDetector } from '../../src/api/tools/streaming-tool-detector.js';

/** Feed chunks through detector and return accumulated text + tool calls */
function processAll(detector: StreamingToolDetector, chunks: string[]) {
  let allText = '';
  const allToolCalls: Array<{ name: string; arguments: Record<string, unknown> }> = [];

  for (const chunk of chunks) {
    const result = detector.processChunk(chunk);
    allText += result.textToEmit;
    allToolCalls.push(...result.completedToolCalls);
  }

  const final = detector.finalize();
  allText += final.textToEmit;
  allToolCalls.push(...final.completedToolCalls);

  return { allText, allToolCalls };
}

describe('StreamingToolDetector', () => {
  describe('code fence detection', () => {
    it('detects tool call in code fence format', () => {
      const detector = new StreamingToolDetector();
      const { allText, allToolCalls } = processAll(detector, [
        'Here is the result: ',
        '```json\n{"name":"get_weather",',
        '"arguments":{"city":"Paris"}}',
        '```',
        ' Done!',
      ]);

      expect(allToolCalls).toHaveLength(1);
      expect(allToolCalls[0].name).toBe('get_weather');
      expect(allToolCalls[0].arguments).toEqual({ city: 'Paris' });
      expect(allText).toContain('Here is the result:');
      expect(allText).toContain('Done!');
      expect(allText).not.toContain('get_weather');
    });

    it('detects tool call in code fence without json tag', () => {
      const detector = new StreamingToolDetector();
      const { allToolCalls } = processAll(detector, [
        '```\n{"name":"notag","arguments":{}}\n```',
      ]);

      expect(allToolCalls).toHaveLength(1);
      expect(allToolCalls[0].name).toBe('notag');
    });

    it('detects tool call with parameters alias', () => {
      const detector = new StreamingToolDetector();
      const { allToolCalls } = processAll(detector, [
        '```json\n{"name":"search","parameters":{"q":"weather"}}\n```',
      ]);

      expect(allToolCalls).toHaveLength(1);
      expect(allToolCalls[0]).toEqual({ name: 'search', arguments: { q: 'weather' } });
    });

    it('detects multiple tool calls', () => {
      const detector = new StreamingToolDetector();
      const { allToolCalls } = processAll(detector, [
        `First tool:\n\`\`\`json\n{"name":"tool1","arguments":{"a":1}}\n\`\`\`\nSecond tool:\n\`\`\`json\n{"name":"tool2","arguments":{"b":2}}\n\`\`\`\nDone`,
      ]);

      expect(allToolCalls).toHaveLength(2);
      expect(allToolCalls[0].name).toBe('tool1');
      expect(allToolCalls[1].name).toBe('tool2');
    });

    it('emits incomplete JSON at stream end as text', () => {
      const detector = new StreamingToolDetector();
      const { allText, allToolCalls } = processAll(detector, [
        '```json\n{"name":"incomplete",',
        '"arguments":{',
      ]);

      expect(allToolCalls).toHaveLength(0);
      expect(allText).toContain('incomplete');
    });
  });

  describe('raw JSON detection', () => {
    it('detects tool call in raw JSON format', () => {
      const detector = new StreamingToolDetector();
      const { allToolCalls } = processAll(detector, [
        'I will call the function:\n',
        '{"name":"search",',
        '"arguments":{"query":"test"}}',
        '\nDone',
      ]);

      expect(allToolCalls).toHaveLength(1);
      expect(allToolCalls[0].name).toBe('search');
      expect(allToolCalls[0].arguments).toEqual({ query: 'test' });
    });

    it('handles nested braces in arguments', () => {
      const detector = new StreamingToolDetector();
      const { allToolCalls } = processAll(detector, [
        '\n{"name":"complex","arguments":{"nested":{"deep":{"value":42}}}}',
      ]);

      expect(allToolCalls).toHaveLength(1);
      expect(allToolCalls[0].name).toBe('complex');
      expect(allToolCalls[0].arguments).toEqual({ nested: { deep: { value: 42 } } });
    });

    it('handles escaped quotes in arguments', () => {
      const detector = new StreamingToolDetector();
      const { allToolCalls } = processAll(detector, [
        '\n{"name":"quote_test","arguments":{"text":"say \\"hello\\" world"}}',
      ]);

      expect(allToolCalls).toHaveLength(1);
      expect(allToolCalls[0].arguments).toEqual({ text: 'say "hello" world' });
    });

    it('detects nested OpenAI function shape', () => {
      const detector = new StreamingToolDetector();
      const { allToolCalls } = processAll(detector, [
        '\n{"type":"function","function":{"name":"GetWeather","arguments":"{\\"city\\":\\"Boston\\"}"}}',
      ]);

      expect(allToolCalls).toHaveLength(1);
      expect(allToolCalls[0]).toEqual({ name: 'GetWeather', arguments: { city: 'Boston' } });
    });

    it('detects raw JSON with character-by-character streaming', () => {
      const detector = new StreamingToolDetector();
      const json = '{\n  "name": "HassTurnOff",\n  "arguments": {\n    "name": "office"\n  }\n}';
      const { allToolCalls } = processAll(detector, [...json]);

      expect(allToolCalls).toHaveLength(1);
      expect(allToolCalls[0].name).toBe('HassTurnOff');
      expect(allToolCalls[0].arguments).toEqual({ name: 'office' });
    });

    it('detects raw JSON with chunks splitting strings', () => {
      const detector = new StreamingToolDetector();
      const { allToolCalls } = processAll(detector, [
        '{\n  "na',
        'me": "Has',
        'sTurnOff",\n  "argu',
        'ments": {\n    "na',
        'me": "off',
        'ice"\n  }\n}',
      ]);

      expect(allToolCalls).toHaveLength(1);
      expect(allToolCalls[0].name).toBe('HassTurnOff');
      expect(allToolCalls[0].arguments).toEqual({ name: 'office' });
    });

    it('handles strings containing brace characters', () => {
      const detector = new StreamingToolDetector();
      const { allToolCalls } = processAll(detector, [
        '{\n  "name": "test",\n  "argu',
        'ments": {\n    "text": "hello {wor',
        'ld} bye"\n  }\n}',
      ]);

      expect(allToolCalls).toHaveLength(1);
      expect(allToolCalls[0].name).toBe('test');
      expect(allToolCalls[0].arguments).toEqual({ text: 'hello {world} bye' });
    });
  });

  describe('non-tool content', () => {
    it('passes non-tool JSON through as text', () => {
      const detector = new StreamingToolDetector();
      const { allText, allToolCalls } = processAll(detector, [
        'Here is some config:\n',
        '{"foo":"bar","baz":123}',
        '\nEnd',
      ]);

      expect(allToolCalls).toHaveLength(0);
      expect(allText).toContain('foo');
      expect(allText).toContain('bar');
    });
  });
});
