/**
 * Unit tests for StreamingToolDetector
 *
 * Tests the state machine that detects JSON tool calls in streaming text,
 * supporting both code fence (```json) and raw JSON formats.
 */

import { describe, it, expect } from 'vitest';
import { StreamingToolDetector } from '../../src/api/tools/streaming-tool-detector.js';
import { ToolMatcher } from '../../src/api/tools/tool-matcher.js';
import type { OpenAITool } from '../../src/api/types.js';

/** Build a minimal OpenAI-style tool declaration for tests. */
function tool(name: string): OpenAITool {
  return { type: 'function', function: { name, parameters: { type: 'object', properties: {} } } } as OpenAITool;
}

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

    it('detects OpenAI-style function_call in code fence and parses string arguments', () => {
      const detector = new StreamingToolDetector();
      const { allToolCalls } = processAll(detector, [
        '```json\n{"type":"function_call","name":"exec","arguments":"{\\"command\\":\\"echo hi\\"}"}\n```',
      ]);

      expect(allToolCalls).toHaveLength(1);
      expect(allToolCalls[0]).toEqual({ name: 'exec', arguments: { command: 'echo hi' } });
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

    it('detects the closing fence when it is split across chunks with trailing content in the same chunk (regression)', () => {
      // This reproduces a real-world failure: the model's closing "```" is
      // split as "``" (end of one chunk) + "`" immediately followed by more
      // text in the very next chunk. The old implementation only checked
      // `pendingText` in isolation and only recognized the fallback when the
      // buffer ended in EXACTLY "```" with nothing after - so this exact
      // shape leaked the closing fence into the "JSON" and broke parsing.
      const detector = new StreamingToolDetector();
      const { allText, allToolCalls } = processAll(detector, [
        '```json\n{"name":"write_file","arguments":{"path":"a.txt"}}\n``',
        '`\nAnd here is some more explanation.',
      ]);

      expect(allToolCalls).toHaveLength(1);
      expect(allToolCalls[0]).toEqual({ name: 'write_file', arguments: { path: 'a.txt' } });
      expect(allText).toContain('And here is some more explanation.');
      expect(allText).not.toContain('write_file');
    });

    it('detects the closing fence split one character at a time across three chunks', () => {
      const detector = new StreamingToolDetector();
      const { allText, allToolCalls } = processAll(detector, [
        '```json\n{"name":"read_file","arguments":{}}\n`',
        '`',
        '`\nDone talking.',
      ]);

      expect(allToolCalls).toHaveLength(1);
      expect(allToolCalls[0].name).toBe('read_file');
      expect(allText).toContain('Done talking.');
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

  describe('matching against declared OpenAI tools', () => {
    it('without a matcher, accepts any tool-shaped JSON (legacy behavior)', () => {
      const detector = new StreamingToolDetector();
      const { allToolCalls } = processAll(detector, [
        '{"name":"totally_made_up","arguments":{"x":1}}',
      ]);
      expect(allToolCalls).toHaveLength(1);
      expect(allToolCalls[0].name).toBe('totally_made_up');
    });

    it('rejects tool-shaped JSON whose name matches no declared tool (false positive fix)', () => {
      const matcher = new ToolMatcher([tool('get_weather'), tool('search')]);
      const detector = new StreamingToolDetector(matcher);

      // The model is just illustrating a JSON payload in its answer; it is
      // NOT calling any of the two declared tools.
      const { allText, allToolCalls } = processAll(detector, [
        'Sure, here is an example payload: ',
        '{"name":"Alice","arguments":{"age":30}}',
        ' - hope that helps!',
      ]);

      expect(allToolCalls).toHaveLength(0);
      expect(allText).toContain('example payload');
      expect(allText).toContain('Alice');
    });

    it('accepts a call whose name exactly matches a declared tool', () => {
      const matcher = new ToolMatcher([tool('get_weather'), tool('search')]);
      const detector = new StreamingToolDetector(matcher);

      const { allToolCalls } = processAll(detector, [
        '{"name":"get_weather","arguments":{"city":"Paris"}}',
      ]);

      expect(allToolCalls).toHaveLength(1);
      expect(allToolCalls[0].name).toBe('get_weather');
    });

    it('fuzzy-matches a slightly mangled tool name to the declared tool', () => {
      const matcher = new ToolMatcher([tool('get_weather')]);
      const detector = new StreamingToolDetector(matcher);

      // Small open-source model drops a letter and uses a space instead of "_"
      const { allToolCalls } = processAll(detector, [
        '{"name":"get weathr","arguments":{"city":"Paris"}}',
      ]);

      expect(allToolCalls).toHaveLength(1);
      expect(allToolCalls[0].name).toBe('get_weather');
    });

    it('rejects a name too different from any declared tool even in tool shape', () => {
      const matcher = new ToolMatcher([tool('get_weather')]);
      const detector = new StreamingToolDetector(matcher);

      const { allToolCalls } = processAll(detector, [
        '{"name":"delete_database","arguments":{}}',
      ]);

      expect(allToolCalls).toHaveLength(0);
    });
  });

  describe('parallel tool calls (JSON array)', () => {
    it('detects parallel tool calls in a fenced JSON array', () => {
      const matcher = new ToolMatcher([tool('get_weather'), tool('get_time')]);
      const detector = new StreamingToolDetector(matcher);

      const { allToolCalls } = processAll(detector, [
        '```json\n',
        '[{"name":"get_weather","arguments":{"city":"Paris"}},',
        '{"name":"get_time","arguments":{"tz":"CET"}}]\n```',
      ]);

      expect(allToolCalls).toHaveLength(2);
      expect(allToolCalls[0]).toEqual({ name: 'get_weather', arguments: { city: 'Paris' } });
      expect(allToolCalls[1]).toEqual({ name: 'get_time', arguments: { tz: 'CET' } });
    });

    it('detects parallel tool calls in a raw (non-fenced) JSON array', () => {
      const matcher = new ToolMatcher([tool('get_weather'), tool('get_time')]);
      const detector = new StreamingToolDetector(matcher);

      const { allToolCalls } = processAll(detector, [
        'Sure, calling both:\n',
        '[{"name": "get_weather", "arguments": {"city": "Paris"}}, ',
        '{"name": "get_time", "arguments": {"tz": "CET"}}]',
      ]);

      expect(allToolCalls).toHaveLength(2);
      expect(allToolCalls.map((c) => c.name)).toEqual(['get_weather', 'get_time']);
    });

    it('handles a raw JSON array split byte-by-byte across many chunks', () => {
      const matcher = new ToolMatcher([tool('a'), tool('b'), tool('c')]);
      const detector = new StreamingToolDetector(matcher);

      const json = '[{"name":"a","arguments":{}},{"name":"b","arguments":{}},{"name":"c","arguments":{}}]';
      const chunks = json.split('');
      const { allToolCalls } = processAll(detector, chunks);

      expect(allToolCalls).toHaveLength(3);
      expect(allToolCalls.map((c) => c.name)).toEqual(['a', 'b', 'c']);
    });

    it('drops array elements that match no declared tool but keeps the valid ones', () => {
      const matcher = new ToolMatcher([tool('get_weather')]);
      const detector = new StreamingToolDetector(matcher);

      const { allToolCalls } = processAll(detector, [
        '[{"name":"get_weather","arguments":{"city":"Paris"}},',
        '{"name":"totally_unrelated","arguments":{}}]',
      ]);

      expect(allToolCalls).toHaveLength(1);
      expect(allToolCalls[0].name).toBe('get_weather');
    });

    it('passes a plain (non-tool-shaped) JSON array through as text', () => {
      const detector = new StreamingToolDetector();
      const { allText, allToolCalls } = processAll(detector, [
        'Here is a list: ',
        '[1, 2, 3, {"foo":"bar"}]',
      ]);

      expect(allToolCalls).toHaveLength(0);
      expect(allText).toContain('[1, 2, 3');
    });
  });

  describe('JSON tool call content containing literal ``` (regression)', () => {
    it('does not let a literal ``` inside a JSON string argument close the fence early', () => {
      // Reproduces a real-world failure: a write_file call whose "content"
      // argument is a markdown file that itself contains fenced code
      // blocks. A naive text scan for the closing "```" matches the FIRST
      // occurrence - which is inside the JSON string, not the real fence
      // end - corrupting the tool call and leaking raw JSON into the chat.
      const matcher = new ToolMatcher([tool('write_file')]);
      const detector = new StreamingToolDetector(matcher);

      const fileContent = '# Title\n\nSome text.\n\n```bash\necho hi\n```\n\nMore text.\n\n```\nplain fenced block\n```\n';
      const payload = JSON.stringify({ name: 'write_file', arguments: { file_path: 'a.md', content: fileContent } });

      const { allToolCalls, allText } = processAll(detector, [
        '```json\n',
        payload,
        '\n```',
        '\nDone writing the file.',
      ]);

      expect(allToolCalls).toHaveLength(1);
      expect(allToolCalls[0].name).toBe('write_file');
      expect(allToolCalls[0].arguments).toEqual({ file_path: 'a.md', content: fileContent });
      expect(allText).toContain('Done writing the file.');
      // The raw tool-call JSON must never leak into the visible text.
      expect(allText).not.toContain('"name"');
    });

    it('handles embedded ``` split arbitrarily across many small chunks', () => {
      const matcher = new ToolMatcher([tool('write_file')]);
      const detector = new StreamingToolDetector(matcher);

      const fileContent = 'Tree:\n\n```\n.\n├── a\n└── b\n```\n';
      const payload = JSON.stringify({ name: 'write_file', arguments: { path: 'x.md', content: fileContent } });
      const full = '```json\n' + payload + '\n```\nAll done.';

      // Split into small, arbitrary chunks (not aligned to any boundary).
      const chunks: string[] = [];
      for (let i = 0; i < full.length; i += 3) {
        chunks.push(full.slice(i, i + 3));
      }

      const { allToolCalls, allText } = processAll(detector, chunks);

      expect(allToolCalls).toHaveLength(1);
      expect(allToolCalls[0].arguments).toEqual({ path: 'x.md', content: fileContent });
      expect(allText).toContain('All done.');
    });

    it('still detects a parallel-tool-call array whose arguments contain literal ```', () => {
      const matcher = new ToolMatcher([tool('write_file'), tool('read_file')]);
      const detector = new StreamingToolDetector(matcher);

      const content = 'See ```code``` here.';
      const payload = JSON.stringify([
        { name: 'write_file', arguments: { path: 'a.md', content } },
        { name: 'read_file', arguments: { path: 'a.md' } },
      ]);

      const { allToolCalls } = processAll(detector, ['```json\n', payload, '\n```']);

      expect(allToolCalls).toHaveLength(2);
      expect(allToolCalls[0]).toEqual({ name: 'write_file', arguments: { path: 'a.md', content } });
      expect(allToolCalls[1]).toEqual({ name: 'read_file', arguments: { path: 'a.md' } });
    });
  });
});
