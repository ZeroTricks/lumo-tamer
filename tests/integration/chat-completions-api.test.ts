/**
 * Integration tests for /v1/chat/completions endpoint
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestServer, parseSSEEvents, type TestServer } from '../helpers/test-server.js';

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
});
