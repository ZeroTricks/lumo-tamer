/**
 * E2E test: OpenAI JS SDK against test server
 *
 * Validates that our /v1/responses endpoint produces SSE events
 * that the official OpenAI SDK can parse without errors.
 *
 * Ported from tests/test-openai-sdk-streaming.ts (ad-hoc script)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import OpenAI from 'openai';
import { createTestServer, type TestServer } from '../helpers/test-server.js';

let ts: TestServer;
let client: OpenAI;

beforeAll(async () => {
  ts = await createTestServer('success');
  client = new OpenAI({
    baseURL: `${ts.baseUrl}/v1`,
    apiKey: 'test-key',
  });
});

afterAll(async () => {
  await ts.close();
});

// Expected structural event sequence (excluding repeated deltas)
const EXPECTED_SEQUENCE = [
  'response.created',
  'response.in_progress',
  'response.output_item.added',
  'response.content_part.added',
  // ... zero or more response.output_text.delta ...
  'response.output_text.done',
  'response.content_part.done',
  'response.output_item.done',
  'response.completed',
];

describe('OpenAI SDK - Responses API', () => {
  describe('streaming', () => {
    let eventTypes: string[];
    let fullText: string;

    beforeAll(async () => {
      eventTypes = [];
      fullText = '';

      const stream = await client.responses.create({
        model: 'lumo',
        input: 'Say hello in one short sentence.',
        stream: true,
      });

      for await (const event of stream) {
        eventTypes.push(event.type);
        if (event.type === 'response.output_text.delta') {
          fullText += event.delta;
        }
      }
    });

    it('receives response.created first', () => {
      expect(eventTypes[0]).toBe('response.created');
    });

    it('receives response.in_progress second', () => {
      expect(eventTypes[1]).toBe('response.in_progress');
    });

    it('receives response.output_item.added', () => {
      expect(eventTypes).toContain('response.output_item.added');
    });

    it('receives response.content_part.added', () => {
      expect(eventTypes).toContain('response.content_part.added');
    });

    it('receives response.output_text.done', () => {
      expect(eventTypes).toContain('response.output_text.done');
    });

    it('receives response.content_part.done', () => {
      expect(eventTypes).toContain('response.content_part.done');
    });

    it('receives response.output_item.done', () => {
      expect(eventTypes).toContain('response.output_item.done');
    });

    it('receives response.completed last', () => {
      expect(eventTypes[eventTypes.length - 1]).toBe('response.completed');
    });

    it('event order matches OpenAI spec', () => {
      const structural = eventTypes.filter(t => t !== 'response.output_text.delta');
      for (let i = 0; i < EXPECTED_SEQUENCE.length; i++) {
        expect(structural[i]).toBe(EXPECTED_SEQUENCE[i]);
      }
    });

    it('has non-empty text', () => {
      expect(fullText.length).toBeGreaterThan(0);
    });

    it('at least one text delta received', () => {
      const deltaCount = eventTypes.filter(t => t === 'response.output_text.delta').length;
      expect(deltaCount).toBeGreaterThan(0);
    });
  });

  describe('non-streaming', () => {
    it('returns completed response with output text', async () => {
      const response = await client.responses.create({
        model: 'lumo',
        input: 'Say hello in one short sentence.',
      });

      expect(response.status).toBe('completed');
      expect(response.output.length).toBeGreaterThan(0);
      expect(response.output_text.length).toBeGreaterThan(0);
    });
  });
});
