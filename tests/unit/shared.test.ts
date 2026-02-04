/**
 * Unit tests for shared route utilities
 *
 * Tests ID generators and tool extraction from non-streaming responses.
 */

import { describe, it, expect } from 'vitest';
import {
  generateResponseId,
  generateItemId,
  generateFunctionCallId,
  generateCallId,
  generateChatCompletionId,
  extractToolsFromResponse,
} from '../../src/api/routes/shared.js';

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

  it('generateCallId returns call_{24-char-hex} format', () => {
    const id = generateCallId();
    expect(id).toMatch(/^call_[0-9a-f]{24}$/);
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

describe('extractToolsFromResponse', () => {
  it('returns original content when hasCustomTools is false', () => {
    const result = extractToolsFromResponse('Some response text', false);
    expect(result.content).toBe('Some response text');
    expect(result.toolCalls).toEqual([]);
  });

  it('extracts and strips tool calls when hasCustomTools is true', () => {
    const response = 'Result:\n```json\n{"name":"search","arguments":{"q":"test"}}\n```\nDone.';
    const result = extractToolsFromResponse(response, true);

    expect(result.toolCalls.length).toBeGreaterThanOrEqual(1);
    expect(result.toolCalls[0].name).toBe('search');
    expect(result.toolCalls[0].arguments).toBe('{"q":"test"}');
    expect(result.content).toContain('Done.');
  });

  it('returns empty toolCalls array when no tools found', () => {
    const result = extractToolsFromResponse('Just plain text', true);
    expect(result.toolCalls).toEqual([]);
    expect(result.content).toBe('Just plain text');
  });
});
