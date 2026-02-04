/**
 * Integration tests for /health and /v1/models endpoints
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestServer, type TestServer } from '../helpers/test-server.js';

let ts: TestServer;

beforeAll(async () => {
  ts = await createTestServer('success');
});

afterAll(async () => {
  await ts.close();
});

describe('GET /health', () => {
  it('returns ok status with queue info', async () => {
    const res = await fetch(`${ts.baseUrl}/health`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.queue).toEqual({ size: 0, pending: 0 });
  });
});

describe('GET /v1/models', () => {
  it('returns list with single model', async () => {
    const res = await fetch(`${ts.baseUrl}/v1/models`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.object).toBe('list');
    expect(body.data).toHaveLength(1);
    expect(body.data[0].object).toBe('model');
    expect(body.data[0].owned_by).toBe('proton');
  });

  it('model id matches config apiModelName', async () => {
    const res = await fetch(`${ts.baseUrl}/v1/models`);
    const body = await res.json();
    // Default from config.defaults.yaml
    expect(body.data[0].id).toBe('lumo');
  });
});
