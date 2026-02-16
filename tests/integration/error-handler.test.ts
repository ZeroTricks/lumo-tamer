/**
 * Integration tests for API error handler middleware
 *
 * Tests OpenAI-compatible error formatting for body parsing errors.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { setupApiErrorHandler } from '../../src/api/error-handler.js';

describe('API error handler', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const app = express();
    // Very small limit to trigger 413 easily
    app.use(express.json({ limit: '100b' }));

    app.post('/test', (_req, res) => {
      res.json({ ok: true });
    });

    app.use(setupApiErrorHandler());

    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://localhost:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('returns 413 with OpenAI error format when body exceeds limit', async () => {
    // Send a body larger than 100 bytes
    const largeBody = { data: 'x'.repeat(200) };

    const res = await fetch(`${baseUrl}/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(largeBody),
    });

    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.error).toEqual({
      message: 'Request body too large for this server. Reduce payload size or increase server.bodyLimit',
      type: 'invalid_request_error',
      param: null,
      code: 'request_too_large',
    });
  });

  it('returns 400 with OpenAI error format for malformed JSON', async () => {
    const res = await fetch(`${baseUrl}/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{ invalid json }',
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toEqual({
      message: 'Malformed JSON in request body.',
      type: 'invalid_request_error',
      param: null,
      code: 'invalid_json',
    });
  });

  it('passes through valid small requests', async () => {
    const res = await fetch(`${baseUrl}/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
  });
});
