/**
 * Integration tests for /v1/responses endpoint
 *
 * Uses a test server with mock ProtonApi to validate request/response
 * formatting without hitting any real API.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestServer, parseSSEEvents, type TestServer } from '../helpers/test-server.js';
import { getCustomToolsConfig } from '../../src/app/config.js';

/** POST /v1/responses with JSON body, returning the raw Response. */
function postResponses(ts: TestServer, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${ts.baseUrl}/v1/responses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('/v1/responses', () => {
  describe('non-streaming (success)', () => {
    let ts: TestServer;

    beforeAll(async () => {
      ts = await createTestServer('success');
    });
    afterAll(async () => { await ts.close(); });

    it('returns completed response with output text', async () => {
      const res = await postResponses(ts, { input: 'Hello', stream: false });

      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body.status).toBe('completed');
      expect(body.object).toBe('response');
      expect(body.id).toMatch(/^resp-/);
    });

    it('response has correct output structure', async () => {
      const res = await postResponses(ts, { input: 'Hello', stream: false });

      const body = await res.json();
      expect(body.output).toBeInstanceOf(Array);
      expect(body.output.length).toBeGreaterThanOrEqual(1);

      const messageItem = body.output[0];
      expect(messageItem.type).toBe('message');
      expect(messageItem.role).toBe('assistant');
      expect(messageItem.content).toBeInstanceOf(Array);
      expect(messageItem.content[0].type).toBe('output_text');
      expect(messageItem.content[0].text.length).toBeGreaterThan(0);
    });

    it('handles string input', async () => {
      const res = await postResponses(ts, { input: 'Tell me a joke', stream: false });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.output[0].content[0].text).toContain('Mocked');
    });

    it('handles message array input', async () => {
      const res = await postResponses(ts, {
        input: [
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Hi!' },
          { role: 'user', content: 'Tell me more' },
        ],
        stream: false,
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('completed');
    });

    it('returns 400 for missing input', async () => {
      const res = await postResponses(ts, { stream: false });

      expect(res.status).toBe(400);
    });
  });

  describe('streaming (success)', () => {
    let ts: TestServer;

    beforeAll(async () => {
      ts = await createTestServer('success');
    });
    afterAll(async () => { await ts.close(); });

    it('returns SSE event stream with correct lifecycle', async () => {
      const res = await postResponses(ts, { input: 'Hello', stream: true });

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/event-stream');

      const text = await res.text();
      const events = parseSSEEvents(text);

      expect(events.length).toBeGreaterThan(0);

      // Check event sequence
      const eventTypes = events.map(e => (e.data as any)?.type).filter(Boolean);
      expect(eventTypes[0]).toBe('response.created');
      expect(eventTypes[1]).toBe('response.in_progress');
      expect(eventTypes[eventTypes.length - 1]).toBe('response.completed');
    });

    it('contains text delta events', async () => {
      const res = await postResponses(ts, { input: 'Hello', stream: true });

      const text = await res.text();
      const events = parseSSEEvents(text);
      const deltaEvents = events.filter(e => (e.data as any)?.type === 'response.output_text.delta');

      expect(deltaEvents.length).toBeGreaterThan(0);
    });

    it('contains output_text.done event with full text', async () => {
      const res = await postResponses(ts, { input: 'Hello', stream: true });

      const text = await res.text();
      const events = parseSSEEvents(text);
      const doneEvent = events.find(e => (e.data as any)?.type === 'response.output_text.done');

      expect(doneEvent).toBeDefined();
      expect((doneEvent!.data as any).text.length).toBeGreaterThan(0);
    });
  });

  describe('confusedToolCall scenario (bounce)', () => {
    let ts: TestServer;
    const dummyTools = [{ type: 'function', function: { name: 'GetLiveContext', parameters: {} } }];

    beforeAll(async () => {
      ts = await createTestServer('confusedToolCall');
      // Enable custom tool detection so the bounce response JSON is parsed
      (getCustomToolsConfig() as any).enabled = true;
    });
    afterAll(async () => {
      (getCustomToolsConfig() as any).enabled = false;
      await ts.close();
    });

    it('non-streaming: bounces confused call and returns function_call from text detection', async () => {
      const res = await postResponses(ts, { input: 'Hello', stream: false, tools: dummyTools });

      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body.status).toBe('completed');

      // Should have a function_call output item for GetLiveContext (detected from bounce response text)
      const functionCall = body.output.find((o: any) => o.type === 'function_call');
      expect(functionCall).toBeDefined();
      expect(functionCall.name).toBe('GetLiveContext');
      expect(functionCall.status).toBe('completed');
    });

    it('streaming: bounces confused call and emits function_call events', async () => {
      const res = await postResponses(ts, { input: 'Hello', stream: true, tools: dummyTools });

      expect(res.status).toBe(200);
      const text = await res.text();
      const events = parseSSEEvents(text);

      // Should have function_call output item added event (from bounce response text detection)
      const functionCallAdded = events.find(e => {
        const data = e.data as any;
        return data?.type === 'response.output_item.added' && data?.item?.type === 'function_call';
      });
      expect(functionCallAdded).toBeDefined();
      expect((functionCallAdded!.data as any).item.name).toBe('GetLiveContext');

      // response.completed should be present
      const completed = events.find(e => (e.data as any)?.type === 'response.completed');
      expect(completed).toBeDefined();
    });
  });

  describe('error scenarios', () => {
    it('error scenario returns response with error', async () => {
      const ts = await createTestServer('error');
      try {
        const res = await postResponses(ts, { input: 'Hello', stream: true });

        const text = await res.text();
        // Should get events even in error case (the stream starts)
        expect(text.length).toBeGreaterThan(0);
      } finally {
        await ts.close();
      }
    });

    it('weeklyLimit scenario returns error', async () => {
      const ts = await createTestServer('weeklyLimit');
      try {
        const res = await postResponses(ts, { input: 'Hello', stream: true });

        const text = await res.text();
        const events = parseSSEEvents(text);
        // Should contain an error event
        const hasError = events.some(e => {
          const data = e.data as any;
          return data?.type === 'error' || data?.error;
        });
        expect(hasError).toBe(true);
      } finally {
        await ts.close();
      }
    });
  });
});
