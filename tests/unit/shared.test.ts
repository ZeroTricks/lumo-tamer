/**
 * Unit tests for shared route utilities
 *
 * Tests ID generators and accumulating tool processor.
 */

import { describe, it, expect } from 'vitest';
import {
  generateResponseId,
  generateItemId,
  generateFunctionCallId,
  generateCallId,
  generateChatCompletionId,
  createAccumulatingToolProcessor,
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
