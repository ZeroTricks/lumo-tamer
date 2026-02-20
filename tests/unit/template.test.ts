/**
 * Unit tests for instructions module
 *
 * Tests template interpolation and replace patterns.
 */

import { describe, it, expect } from 'vitest';
import { sanitizeInstructions } from '../../src/lumo-client/instructions.js';
import { interpolateTemplate } from '../../src/app/template.js';
import { applyReplacePatterns } from '../../src/api/instructions.js'

describe('interpolateTemplate', () => {
  describe('variable substitution', () => {
    it('replaces single variable', () => {
      const result = interpolateTemplate('Hello {{name}}!', { name: 'World' });
      expect(result).toBe('Hello World!');
    });

    it('replaces multiple variables', () => {
      const result = interpolateTemplate('{{a}} and {{b}}', { a: 'one', b: 'two' });
      expect(result).toBe('one and two');
    });

    it('replaces all occurrences of same variable', () => {
      const result = interpolateTemplate('{{x}} + {{x}} = 2{{x}}', { x: '1' });
      expect(result).toBe('1 + 1 = 21');
    });

    it('replaces undefined variables with empty string', () => {
      const result = interpolateTemplate('{{known}} and {{unknown}}', { known: 'value' });
      expect(result).toBe('value and');
    });

    it('handles undefined values by removing them', () => {
      const result = interpolateTemplate('start {{middle}} end', { middle: undefined });
      expect(result).toBe('start  end');
    });

    it('handles empty vars object (replaces with empty string)', () => {
      const result = interpolateTemplate('No {{vars}} here', {});
      expect(result).toBe('No  here');
    });

    it('handles empty template', () => {
      const result = interpolateTemplate('', { key: 'value' });
      expect(result).toBe('');
    });

    it('handles multiline content in variables', () => {
      const result = interpolateTemplate('Start\n{{content}}\nEnd', { content: 'Line1\nLine2' });
      expect(result).toBe('Start\nLine1\nLine2\nEnd');
    });
  });

  describe('{{#if}}...{{/if}} conditionals', () => {
    it('includes content when variable is truthy', () => {
      const result = interpolateTemplate('{{#if show}}visible{{/if}}', { show: 'yes' });
      expect(result).toBe('visible');
    });

    it('excludes content when variable is undefined', () => {
      const result = interpolateTemplate('before{{#if hidden}}invisible{{/if}}after', { hidden: undefined });
      expect(result).toBe('beforeafter');
    });

    it('excludes content when variable is empty string', () => {
      const result = interpolateTemplate('{{#if empty}}content{{/if}}', { empty: '' });
      expect(result).toBe('');
    });

    it('handles multiline content in conditional', () => {
      const template = `{{#if tools}}
Tool instructions here
More lines
{{/if}}`;
      const result = interpolateTemplate(template, { tools: 'yes' });
      expect(result).toContain('Tool instructions here');
      expect(result).toContain('More lines');
    });

    it('handles nested variables in conditional', () => {
      const result = interpolateTemplate('{{#if show}}Hello {{name}}{{/if}}', { show: 'yes', name: 'World' });
      expect(result).toBe('Hello World');
    });
  });

  describe('{{#if}}...{{else}}...{{/if}} conditionals', () => {
    it('uses if-branch when variable is truthy', () => {
      const result = interpolateTemplate('{{#if flag}}yes{{else}}no{{/if}}', { flag: 'true' });
      expect(result).toBe('yes');
    });

    it('uses else-branch when variable is undefined', () => {
      const result = interpolateTemplate('{{#if flag}}yes{{else}}no{{/if}}', { flag: undefined });
      expect(result).toBe('no');
    });

    it('uses else-branch when variable is empty string', () => {
      const result = interpolateTemplate('{{#if flag}}yes{{else}}no{{/if}}', { flag: '' });
      expect(result).toBe('no');
    });

    it('handles multiline if and else branches', () => {
      const template = `{{#if clientInstructions}}
{{clientInstructions}}
{{else}}
{{fallback}}
{{/if}}`;
      const resultWithClient = interpolateTemplate(template, { clientInstructions: 'Client says hi', fallback: 'Default' });
      expect(resultWithClient).toContain('Client says hi');
      expect(resultWithClient).not.toContain('Default');

      const resultWithFallback = interpolateTemplate(template, { clientInstructions: undefined, fallback: 'Default' });
      expect(resultWithFallback).toContain('Default');
    });

    it('handles variables in both branches', () => {
      const result = interpolateTemplate('{{#if a}}{{b}}{{else}}{{c}}{{/if}}', { a: 'yes', b: 'B', c: 'C' });
      expect(result).toBe('B');
    });
  });

  describe('multiple conditionals', () => {
    it('handles multiple if blocks', () => {
      const template = '{{#if a}}A{{/if}} {{#if b}}B{{/if}}';
      expect(interpolateTemplate(template, { a: 'yes', b: 'yes' })).toBe('A B');
      expect(interpolateTemplate(template, { a: 'yes', b: undefined })).toBe('A');
      expect(interpolateTemplate(template, { a: undefined, b: 'yes' })).toBe('B');
    });

    it('handles multiple if-else blocks', () => {
      const template = '{{#if a}}A{{else}}notA{{/if}} {{#if b}}B{{else}}notB{{/if}}';
      expect(interpolateTemplate(template, { a: 'yes', b: undefined })).toBe('A notB');
    });
  });

  describe('whitespace handling', () => {
    it('collapses excessive blank lines', () => {
      const template = 'Line1\n\n\n\n\nLine2';
      const result = interpolateTemplate(template, {});
      expect(result).toBe('Line1\n\nLine2');
    });

    it('trims leading and trailing whitespace', () => {
      const result = interpolateTemplate('  \n\ncontent\n\n  ', {});
      expect(result).toBe('content');
    });

    it('cleans up blank lines left by removed conditionals', () => {
      const template = `Before

{{#if missing}}
This is removed
{{/if}}

After`;
      const result = interpolateTemplate(template, { missing: undefined });
      expect(result).toBe('Before\n\nAfter');
    });
  });

  describe('real-world template example', () => {
    it('handles full instructions template', () => {
      const template = `{{#if tools}}
{{forTools}}
{{/if}}

{{#if clientInstructions}}
{{clientInstructions}}
{{else}}
{{fallback}}
{{/if}}

{{#if tools}}
Below are the tools prefixed with {{prefix}}.
{{tools}}
{{/if}}`;

      // With tools and client instructions
      const withTools = interpolateTemplate(template, {
        tools: '[{"name":"user:test"}]',
        forTools: '=== TOOL PROTOCOL ===',
        clientInstructions: 'User instructions',
        fallback: 'Default instructions',
        prefix: 'user:',
      });
      expect(withTools).toContain('=== TOOL PROTOCOL ===');
      expect(withTools).toContain('User instructions');
      expect(withTools).not.toContain('Default instructions');
      expect(withTools).toContain('user:test');

      // Without tools, no client instructions
      const noTools = interpolateTemplate(template, {
        tools: undefined,
        forTools: '=== TOOL PROTOCOL ===',
        clientInstructions: undefined,
        fallback: 'Default instructions',
        prefix: 'user:',
      });
      expect(noTools).not.toContain('=== TOOL PROTOCOL ===');
      expect(noTools).toContain('Default instructions');
      expect(noTools).not.toContain('user:test');
    });
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

describe('sanitizeInstructions', () => {
  it('inserts space between ] and newline to break wrapper pattern', () => {
    const input = 'array: [1, 2, 3]\nNext line';
    const result = sanitizeInstructions(input);
    expect(result).toBe('array: [1, 2, 3] \nNext line');
  });

  it('preserves JSON structure while breaking ] + newline pattern', () => {
    // Note: only ] followed by newline gets space inserted, not }
    const input = '{"items": [1, 2, 3]}\n{"more": true}';
    const result = sanitizeInstructions(input);
    // The ] before } doesn't get modified since it's not followed by newline
    // The } is followed by newline but we only handle ]
    expect(result).toBe('{"items": [1, 2, 3]}\n{"more": true}');
    // JSON is still valid (brackets preserved)
    expect(result).toContain('[');
    expect(result).toContain(']');
  });

  it('handles ] directly followed by newline in JSON array', () => {
    const input = '[\n  1,\n  2\n]\nmore text';
    const result = sanitizeInstructions(input);
    expect(result).toBe('[\n  1,\n  2\n] \nmore text');
  });

  it('handles multiple ] + newline occurrences', () => {
    const input = '[a]\n[b]\n[c]';
    const result = sanitizeInstructions(input);
    expect(result).toBe('[a] \n[b] \n[c]');
  });

  it('collapses excessive newlines', () => {
    const input = 'Line 1\n\n\n\nLine 2';
    const result = sanitizeInstructions(input);
    expect(result).toBe('Line 1\n\nLine 2');
  });

  it('preserves double newlines', () => {
    const input = 'Para 1\n\nPara 2';
    const result = sanitizeInstructions(input);
    expect(result).toBe('Para 1\n\nPara 2');
  });

  it('handles empty string', () => {
    expect(sanitizeInstructions('')).toBe('');
  });

  it('handles text without brackets', () => {
    const input = 'Plain text without any brackets';
    expect(sanitizeInstructions(input)).toBe(input);
  });

  it('does not modify ] not followed by newline', () => {
    const input = '[a] and [b] inline';
    expect(sanitizeInstructions(input)).toBe('[a] and [b] inline');
  });

  it('handles ] at end of string (no newline)', () => {
    const input = 'array: [1, 2, 3]';
    expect(sanitizeInstructions(input)).toBe('array: [1, 2, 3]');
  });
});
