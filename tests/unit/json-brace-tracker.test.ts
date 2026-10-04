/**
 * Unit tests for JsonBraceTracker
 *
 * Tests brace-depth JSON object extraction from chunked input.
 */

import { describe, it, expect } from 'vitest';
import { JsonBraceTracker } from '../../src/api/tools/json-brace-tracker.js';

describe('JsonBraceTracker', () => {
  it('extracts a single complete JSON object', () => {
    const tracker = new JsonBraceTracker();
    const results = tracker.feed('{"name":"test"}');
    expect(results).toEqual(['{"name":"test"}']);
  });

  it('extracts concatenated JSON objects in one chunk', () => {
    const tracker = new JsonBraceTracker();
    const results = tracker.feed('{"a":1}{"b":2}{"c":3}');
    expect(results).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
  });

  it('handles objects split across multiple chunks', () => {
    const tracker = new JsonBraceTracker();
    expect(tracker.feed('{"na')).toEqual([]);
    expect(tracker.feed('me":"')).toEqual([]);
    expect(tracker.feed('test"}')).toEqual(['{"name":"test"}']);
  });

  it('handles nested objects', () => {
    const tracker = new JsonBraceTracker();
    const results = tracker.feed('{"a":{"b":{"c":1}}}');
    expect(results).toEqual(['{"a":{"b":{"c":1}}}']);
  });

  it('handles strings containing braces', () => {
    const tracker = new JsonBraceTracker();
    const results = tracker.feed('{"text":"hello { world }"}');
    expect(results).toEqual(['{"text":"hello { world }"}']);
  });

  it('handles escaped quotes in strings', () => {
    const tracker = new JsonBraceTracker();
    const results = tracker.feed('{"text":"say \\"hello\\""}');
    expect(results).toEqual(['{"text":"say \\"hello\\""}']);
  });

  it('handles escaped backslashes before quotes', () => {
    const tracker = new JsonBraceTracker();
    // A string ending with a literal backslash: "path\\" - the \\\\ is the escaped backslash, then " closes the string
    const results = tracker.feed('{"path":"C:\\\\"}');
    expect(results).toEqual(['{"path":"C:\\\\"}']);
  });

  it('discards text outside JSON objects', () => {
    const tracker = new JsonBraceTracker();
    const results = tracker.feed('prefix{"a":1}middle{"b":2}suffix');
    expect(results).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('returns empty array for incomplete object', () => {
    const tracker = new JsonBraceTracker();
    expect(tracker.feed('{"incomplete')).toEqual([]);
  });

  it('returns empty array for empty input', () => {
    const tracker = new JsonBraceTracker();
    expect(tracker.feed('')).toEqual([]);
  });

  it('handles real Lumo concatenated tool calls', () => {
    const tracker = new JsonBraceTracker();
    const input = '{"name":"GetLiveContext","arguments":{}}{"name":"GetLiveContext"}{"name":"GetLiveContext","arguments":{}}';
    const results = tracker.feed(input);
    expect(results).toHaveLength(3);
    expect(JSON.parse(results[0])).toEqual({ name: 'GetLiveContext', arguments: {} });
    expect(JSON.parse(results[1])).toEqual({ name: 'GetLiveContext' });
    expect(JSON.parse(results[2])).toEqual({ name: 'GetLiveContext', arguments: {} });
  });

  it('handles real Lumo concatenated tool calls arriving in chunks', () => {
    const tracker = new JsonBraceTracker();
    // Simulate chunked delivery
    expect(tracker.feed('{"name":"GetLi')).toEqual([]);
    expect(tracker.feed('veContext","arguments":{')).toEqual([]);
    const results = tracker.feed('}}{"name":"GetLiveContext"}');
    expect(results).toHaveLength(2);
    expect(JSON.parse(results[0])).toEqual({ name: 'GetLiveContext', arguments: {} });
    expect(JSON.parse(results[1])).toEqual({ name: 'GetLiveContext' });
  });

  it('handles real Lumo error results', () => {
    const tracker = new JsonBraceTracker();
    const results = tracker.feed('{"error":true}{"error":true}');
    expect(results).toEqual(['{"error":true}', '{"error":true}']);
  });

  it('extracts a top-level JSON array as one complete unit (parallel tool calls)', () => {
    const tracker = new JsonBraceTracker();
    const results = tracker.feed('[{"name":"a","arguments":{}},{"name":"b","arguments":{}}]');
    expect(results).toHaveLength(1);
    expect(JSON.parse(results[0])).toEqual([
      { name: 'a', arguments: {} },
      { name: 'b', arguments: {} },
    ]);
  });

  it('handles a JSON array split across multiple chunks', () => {
    const tracker = new JsonBraceTracker();
    expect(tracker.feed('[{"name":"a"')).toEqual([]);
    expect(tracker.feed(',"arguments":{}},{"na')).toEqual([]);
    const results = tracker.feed('me":"b","arguments":{}}]');
    expect(results).toHaveLength(1);
    expect(JSON.parse(results[0])).toHaveLength(2);
  });

  describe('feedWithRemainder', () => {
    it('returns remainder after completed object', () => {
      const tracker = new JsonBraceTracker();
      const { results, remainder } = tracker.feedWithRemainder('{"a":1}\nDone');
      expect(results).toEqual(['{"a":1}']);
      expect(remainder).toBe('\nDone');
    });

    it('returns empty remainder when chunk ends at object close', () => {
      const tracker = new JsonBraceTracker();
      const { results, remainder } = tracker.feedWithRemainder('{"a":1}');
      expect(results).toEqual(['{"a":1}']);
      expect(remainder).toBe('');
    });

    it('returns empty remainder when still inside an object', () => {
      const tracker = new JsonBraceTracker();
      const { results, remainder } = tracker.feedWithRemainder('{"incomplete');
      expect(results).toEqual([]);
      expect(remainder).toBe('');
    });

    it('remainder is text after last completed object', () => {
      const tracker = new JsonBraceTracker();
      const { results, remainder } = tracker.feedWithRemainder('{"a":1}{"b":2} trailing');
      expect(results).toEqual(['{"a":1}', '{"b":2}']);
      expect(remainder).toBe(' trailing');
    });
  });

  describe('getBuffer', () => {
    it('returns in-progress buffer', () => {
      const tracker = new JsonBraceTracker();
      tracker.feed('{"partial');
      expect(tracker.getBuffer()).toBe('{"partial');
    });

    it('returns empty after complete object', () => {
      const tracker = new JsonBraceTracker();
      tracker.feed('{"done":1}');
      expect(tracker.getBuffer()).toBe('');
    });
  });

  describe('isActive', () => {
    it('returns false initially', () => {
      const tracker = new JsonBraceTracker();
      expect(tracker.isActive()).toBe(false);
    });

    it('returns true when inside an object', () => {
      const tracker = new JsonBraceTracker();
      tracker.feed('{"partial');
      expect(tracker.isActive()).toBe(true);
    });

    it('returns false after object completes', () => {
      const tracker = new JsonBraceTracker();
      tracker.feed('{"done":1}');
      expect(tracker.isActive()).toBe(false);
    });
  });

  describe('reset', () => {
    it('clears all state', () => {
      const tracker = new JsonBraceTracker();
      tracker.feed('{"partial');
      expect(tracker.isActive()).toBe(true);
      tracker.reset();
      expect(tracker.isActive()).toBe(false);
      expect(tracker.getBuffer()).toBe('');
      // Can track a new object after reset
      const results = tracker.feed('{"new":1}');
      expect(results).toEqual(['{"new":1}']);
    });
  });
});
