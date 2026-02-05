/**
 * Integration tests for /v1/chat/completions endpoint
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createTestServer, parseSSEEvents, type TestServer } from '../helpers/test-server.js';
import { resetCallCounts } from '../../src/mock/mock-api.js';

/** POST /v1/chat/completions with JSON body, returning the raw Response. */
function postChat(ts: TestServer, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${ts.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const userMessage = (content: string) => [{ role: 'user', content }];

let ts: TestServer;

beforeAll(async () => {
  ts = await createTestServer('success');
});

afterAll(async () => {
  await ts.close();
});

describe('/v1/chat/completions', () => {
  describe('non-streaming', () => {
    it('returns chat.completion object', async () => {
      const res = await postChat(ts, {
        model: 'lumo',
        messages: userMessage('Hello'),
        stream: false,
      });

      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body.object).toBe('chat.completion');
      expect(body.id).toMatch(/^chatcmpl-/);
      expect(body.choices).toHaveLength(1);
      expect(body.choices[0].finish_reason).toBe('stop');
      expect(body.choices[0].message.role).toBe('assistant');
      expect(body.choices[0].message.content.length).toBeGreaterThan(0);
    });

    it('response contains mock text', async () => {
      const res = await postChat(ts, {
        model: 'lumo',
        messages: userMessage('Tell me a joke'),
        stream: false,
      });

      const body = await res.json();
      expect(body.choices[0].message.content).toContain('Mocked');
    });

    it('returns 400 for missing messages', async () => {
      const res = await postChat(ts, { model: 'lumo', stream: false });

      expect(res.status).toBe(400);
    });

    it('returns 400 for messages without user role', async () => {
      const res = await postChat(ts, {
        model: 'lumo',
        messages: [{ role: 'system', content: 'You are helpful' }],
        stream: false,
      });

      expect(res.status).toBe(400);
    });
  });

  describe('streaming', () => {
    it('returns SSE chunks ending with [DONE]', async () => {
      const res = await postChat(ts, {
        model: 'lumo',
        messages: userMessage('Hello'),
        stream: true,
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/event-stream');

      const text = await res.text();
      expect(text).toContain('data: [DONE]');
    });

    it('chunks have chat.completion.chunk object type', async () => {
      const res = await postChat(ts, {
        model: 'lumo',
        messages: userMessage('Hello'),
        stream: true,
      });

      const text = await res.text();
      const events = parseSSEEvents(text);
      const jsonEvents = events.filter(e => typeof e.data === 'object');

      expect(jsonEvents.length).toBeGreaterThan(0);

      for (const event of jsonEvents) {
        expect((event.data as any).object).toBe('chat.completion.chunk');
      }
    });

    it('final chunk has finish_reason stop', async () => {
      const res = await postChat(ts, {
        model: 'lumo',
        messages: userMessage('Hello'),
        stream: true,
      });

      const text = await res.text();
      const events = parseSSEEvents(text);
      const jsonEvents = events.filter(e => typeof e.data === 'object');

      // Last JSON event should have finish_reason: 'stop'
      const lastEvent = jsonEvents[jsonEvents.length - 1];
      expect((lastEvent.data as any).choices[0].finish_reason).toBe('stop');
    });
  });

  describe('confusedToolCall scenario', () => {
    let nativeTs: TestServer;

    beforeAll(async () => {
      nativeTs = await createTestServer('confusedToolCall');
    });
    afterAll(async () => { await nativeTs.close(); });
    beforeEach(() => { resetCallCounts(); });

    it('non-streaming: returns tool_calls with suppressed content', async () => {
      const res = await postChat(nativeTs, {
        model: 'lumo',
        messages: userMessage('Hello'),
        stream: false,
      });

      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body.object).toBe('chat.completion');
      expect(body.choices).toHaveLength(1);

      // Should have tool_calls for GetLiveContext
      const choice = body.choices[0];
      expect(choice.finish_reason).toBe('tool_calls');
      expect(choice.message.tool_calls).toBeDefined();
      expect(choice.message.tool_calls.length).toBeGreaterThanOrEqual(1);
      expect(choice.message.tool_calls[0].function.name).toBe('GetLiveContext');

      // Content should be suppressed (empty)
      expect(choice.message.content).toBe('');
    });

    it('streaming: emits tool call delta and suppresses text', async () => {
      const res = await postChat(nativeTs, {
        model: 'lumo',
        messages: userMessage('Hello'),
        stream: true,
      });

      expect(res.status).toBe(200);
      const text = await res.text();
      const events = parseSSEEvents(text);
      const jsonEvents = events.filter(e => typeof e.data === 'object');

      // Should have a tool_calls delta chunk
      const toolCallChunk = jsonEvents.find(e => {
        const delta = (e.data as any)?.choices?.[0]?.delta;
        return delta?.tool_calls?.length > 0;
      });
      expect(toolCallChunk).toBeDefined();
      expect((toolCallChunk!.data as any).choices[0].delta.tool_calls[0].function.name).toBe('GetLiveContext');

      // Final chunk should have finish_reason: 'tool_calls'
      const lastJsonEvent = jsonEvents[jsonEvents.length - 1];
      expect((lastJsonEvent.data as any).choices[0].finish_reason).toBe('tool_calls');

      // Text content delta events should not contain the fallback text
      const contentDeltas = jsonEvents
        .filter(e => (e.data as any)?.choices?.[0]?.delta?.content)
        .map(e => (e.data as any).choices[0].delta.content);
      const fullContent = contentDeltas.join('');
      expect(fullContent).not.toContain("don't have access");
    });
  });
});
