/**
 * Unit tests for prefix helpers and template interpolation
 *
 * Tests the helper functions used for custom tool prefixing,
 * pattern replacement, and template assembly.
 */

import { describe, it, expect } from 'vitest';
import {
  applyToolPrefix,
  stripToolPrefix,
  applyReplacePatterns,
  interpolateTemplate,
} from '../../src/api/tools/prefix.js';
import type { OpenAITool } from '../../src/api/types.js';

describe('applyToolPrefix', () => {
  it('adds prefix to tool names', () => {
    const tools: OpenAITool[] = [
      { type: 'function', function: { name: 'find_files', description: 'Find files', parameters: {} } },
      { type: 'function', function: { name: 'read_file', description: 'Read file', parameters: {} } },
    ];

    const result = applyToolPrefix(tools, 'user:');

    expect(result[0].function.name).toBe('user:find_files');
    expect(result[1].function.name).toBe('user:read_file');
  });

  it('returns unchanged array when prefix is empty', () => {
    const tools: OpenAITool[] = [
      { type: 'function', function: { name: 'find_files', description: 'Find', parameters: {} } },
    ];

    const result = applyToolPrefix(tools, '');

    expect(result[0].function.name).toBe('find_files');
  });

  it('preserves other tool properties', () => {
    const tools: OpenAITool[] = [
      {
        type: 'function',
        function: {
          name: 'search',
          description: 'Search for things',
          parameters: { type: 'object', properties: { query: { type: 'string' } } },
        },
      },
    ];

    const result = applyToolPrefix(tools, 'user:');

    expect(result[0].type).toBe('function');
    expect(result[0].function.description).toBe('Search for things');
    expect(result[0].function.parameters).toEqual({ type: 'object', properties: { query: { type: 'string' } } });
  });

  it('does not mutate original tools array', () => {
    const tools: OpenAITool[] = [
      { type: 'function', function: { name: 'tool1', description: 'Tool', parameters: {} } },
    ];

    applyToolPrefix(tools, 'user:');

    expect(tools[0].function.name).toBe('tool1');
  });

  it('handles flat format tools (e.g., Home Assistant)', () => {
    // Home Assistant sends tools in flat format: { type: "function", name: "...", parameters: {...} }
    const tools = [
      { type: 'function', name: 'HassTurnOn', parameters: { type: 'object', properties: {} }, description: 'Turn on' },
      { type: 'function', name: 'HassTurnOff', parameters: { type: 'object', properties: {} }, description: 'Turn off' },
    ] as unknown as OpenAITool[];

    const result = applyToolPrefix(tools, 'user:');

    expect((result[0] as any).name).toBe('user:HassTurnOn');
    expect((result[1] as any).name).toBe('user:HassTurnOff');
  });

  it('preserves other properties in flat format tools', () => {
    const tools = [
      { type: 'function', name: 'GetDateTime', parameters: { type: 'object' }, description: 'Get time', strict: false },
    ] as unknown as OpenAITool[];

    const result = applyToolPrefix(tools, 'user:');

    expect((result[0] as any).name).toBe('user:GetDateTime');
    expect((result[0] as any).description).toBe('Get time');
    expect((result[0] as any).strict).toBe(false);
  });

  it('handles null/undefined tools gracefully', () => {
    expect(applyToolPrefix(null as any, 'user:')).toBeNull();
    expect(applyToolPrefix(undefined as any, 'user:')).toBeUndefined();
  });

  it('skips tools without name in either format', () => {
    const tools = [
      { type: 'function' },  // no name at all
      { type: 'function', function: {} },  // nested but no name
    ] as unknown as OpenAITool[];

    const result = applyToolPrefix(tools, 'user:');

    expect(result).toHaveLength(2);
    expect((result[0] as any).function).toBeUndefined();
  });
});

describe('stripToolPrefix', () => {
  it('removes prefix from tool name', () => {
    expect(stripToolPrefix('user:find_files', 'user:')).toBe('find_files');
    expect(stripToolPrefix('user:read_file', 'user:')).toBe('read_file');
  });

  it('returns unchanged name when prefix not present', () => {
    expect(stripToolPrefix('find_files', 'user:')).toBe('find_files');
    expect(stripToolPrefix('other:tool', 'user:')).toBe('other:tool');
  });

  it('returns unchanged name when prefix is empty', () => {
    expect(stripToolPrefix('find_files', '')).toBe('find_files');
    expect(stripToolPrefix('user:find_files', '')).toBe('user:find_files');
  });

  it('handles edge cases', () => {
    expect(stripToolPrefix('user:', 'user:')).toBe('');
    expect(stripToolPrefix('', 'user:')).toBe('');
    expect(stripToolPrefix('', '')).toBe('');
  });
});

describe('applyReplacePatterns', () => {
  it('removes matching patterns when no replacement specified (case-insensitive)', () => {
    const text = 'Use only native tool calling. This is important.';
    const patterns = [{ pattern: 'use only native tool calling' }];

    expect(applyReplacePatterns(text, patterns)).toBe('. This is important.');
  });

  it('replaces matching patterns with specified replacement', () => {
    const text = 'Use only native tool calling. This is important.';
    const patterns = [{ pattern: 'use only native tool calling', replacement: 'Follow protocol' }];

    expect(applyReplacePatterns(text, patterns)).toBe('Follow protocol. This is important.');
  });

  it('removes multiple patterns', () => {
    const text = 'Use native calling (no text-based formats allowed). Be careful.';
    const patterns = [
      { pattern: 'use native calling' },
      { pattern: '\\(no text-based formats[^)]*\\)' },
    ];

    expect(applyReplacePatterns(text, patterns)).toBe('. Be careful.');
  });

  it('removes all occurrences of a pattern', () => {
    const text = 'Use native. Then use native again.';
    const patterns = [{ pattern: 'use native' }];

    expect(applyReplacePatterns(text, patterns)).toBe('. Then again.');
  });

  it('returns original text when no patterns match', () => {
    const text = 'This is normal text.';
    const patterns = [{ pattern: 'nonexistent pattern' }];

    expect(applyReplacePatterns(text, patterns)).toBe('This is normal text.');
  });

  it('returns original text when patterns array is empty', () => {
    const text = 'Original text here.';

    expect(applyReplacePatterns(text, [])).toBe('Original text here.');
  });

  it('cleans up extra whitespace left by removals', () => {
    const text = 'Line one.\n\nBad pattern here.\n\n\nLine two.';
    const patterns = [{ pattern: 'Bad pattern here\\.' }];

    const result = applyReplacePatterns(text, patterns);
    // Should collapse multiple newlines
    expect(result).not.toContain('\n\n\n');
  });

  it('skips invalid regex patterns gracefully', () => {
    const text = 'Some text here.';
    const patterns = [{ pattern: '[invalid regex' }, { pattern: 'valid pattern' }];

    // Should not throw, should process valid patterns
    expect(() => applyReplacePatterns(text, patterns)).not.toThrow();
  });

  it('supports regex capture groups in replacement', () => {
    const text = 'Call function foo() now.';
    const patterns = [{ pattern: 'function (\\w+)\\(\\)', replacement: 'method $1' }];

    expect(applyReplacePatterns(text, patterns)).toBe('Call method foo now.');
  });
});

describe('interpolateTemplate', () => {
  it('replaces single variable', () => {
    const template = 'Hello {name}!';
    const result = interpolateTemplate(template, { name: 'World' });

    expect(result).toBe('Hello World!');
  });

  it('replaces multiple variables', () => {
    const template = '{forTools}\n\n{clientInstructions}\n\n{toolsJson}';
    const result = interpolateTemplate(template, {
      forTools: 'Tool protocol here',
      clientInstructions: 'Client says this',
      toolsJson: '{"tools": []}',
    });

    expect(result).toBe('Tool protocol here\n\nClient says this\n\n{"tools": []}');
  });

  it('replaces all occurrences of same variable', () => {
    const template = '{x} + {x} = 2{x}';
    const result = interpolateTemplate(template, { x: '1' });

    expect(result).toBe('1 + 1 = 21');
  });

  it('leaves unmatched placeholders unchanged', () => {
    const template = '{known} and {unknown}';
    const result = interpolateTemplate(template, { known: 'value' });

    expect(result).toBe('value and {unknown}');
  });

  it('handles empty vars object', () => {
    const template = 'No {vars} here';
    const result = interpolateTemplate(template, {});

    expect(result).toBe('No {vars} here');
  });

  it('handles empty template', () => {
    const result = interpolateTemplate('', { key: 'value' });

    expect(result).toBe('');
  });

  it('handles multiline content in variables', () => {
    const template = 'Start\n{content}\nEnd';
    const result = interpolateTemplate(template, { content: 'Line1\nLine2\nLine3' });

    expect(result).toBe('Start\nLine1\nLine2\nLine3\nEnd');
  });
});
