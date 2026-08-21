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
  it('returns the list of allowed model tiers', async () => {
    const res = await fetch(`${ts.baseUrl}/v1/models`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.object).toBe('list');
    expect(body.data.length).toBeGreaterThanOrEqual(1);
    expect(body.data[0].object).toBe('model');
    expect(body.data[0].owned_by).toBe('proton');
  });

  it('advertises the tier models from config.allowedModels', async () => {
    const res = await fetch(`${ts.baseUrl}/v1/models`);
    const body = await res.json();
    const ids = body.data.map((m: { id: string }) => m.id);
    // Defaults from config.defaults.yaml
    expect(ids).toEqual(['lumo', 'lumo-lite', 'lumo-max']);
  });
});
