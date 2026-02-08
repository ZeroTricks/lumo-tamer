/**
 * Unit tests for prefix helpers
 *
 * Tests the helper functions used for custom tool prefixing
 * and pattern replacement.
 *
 * Note: Template interpolation tests are in template.test.ts
 */

import { describe, it, expect } from 'vitest';
import {
  applyToolPrefix,
  stripToolPrefix,
  applyToolNamePrefix,
  applyReplacePatterns,
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

describe('applyToolNamePrefix', () => {
  it('prefixes tool names in text', () => {
    const text = 'Use find_files to search for documents.';
    const result = applyToolNamePrefix(text, ['find_files'], 'user:');

    expect(result).toBe('Use user:find_files to search for documents.');
  });

  it('prefixes multiple tool names', () => {
    const text = 'Use find_files to locate, then read_file to view contents.';
    const result = applyToolNamePrefix(text, ['find_files', 'read_file'], 'user:');

    expect(result).toBe('Use user:find_files to locate, then user:read_file to view contents.');
  });

  it('prefixes all occurrences of a tool name', () => {
    const text = 'Call find_files first, then find_files again if needed.';
    const result = applyToolNamePrefix(text, ['find_files'], 'user:');

    expect(result).toBe('Call user:find_files first, then user:find_files again if needed.');
  });

  it('respects word boundaries (no partial matches)', () => {
    const text = 'Use read_file but not read_file_sync or myread_file.';
    const result = applyToolNamePrefix(text, ['read_file'], 'user:');

    expect(result).toBe('Use user:read_file but not read_file_sync or myread_file.');
  });

  it('skips already-prefixed names', () => {
    const text = 'Use user:find_files which is already prefixed.';
    const result = applyToolNamePrefix(text, ['find_files'], 'user:');

    expect(result).toBe('Use user:find_files which is already prefixed.');
  });

  it('returns unchanged when prefix is empty', () => {
    const text = 'Use find_files to search.';
    const result = applyToolNamePrefix(text, ['find_files'], '');

    expect(result).toBe('Use find_files to search.');
  });

  it('returns unchanged when tool names array is empty', () => {
    const text = 'Use find_files to search.';
    const result = applyToolNamePrefix(text, [], 'user:');

    expect(result).toBe('Use find_files to search.');
  });

  it('returns unchanged when text is empty', () => {
    const result = applyToolNamePrefix('', ['find_files'], 'user:');

    expect(result).toBe('');
  });

  it('handles tool names with dots (special regex characters)', () => {
    // Tool names with dots are escaped properly
    const text = 'Use get.data to fetch information.';
    const result = applyToolNamePrefix(text, ['get.data'], 'user:');

    expect(result).toBe('Use user:get.data to fetch information.');
  });

  it('handles prefix with special regex characters', () => {
    const text = 'Use find_files tool.';
    const result = applyToolNamePrefix(text, ['find_files'], 'ns:v1:');

    expect(result).toBe('Use ns:v1:find_files tool.');
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

