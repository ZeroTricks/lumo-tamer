/**
 * Integration tests for /metrics endpoint
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { createResponsesRouter } from '../../src/api/routes/responses/index.js';
import { createHealthRouter } from '../../src/api/routes/health.js';
import { RequestQueue } from '../../src/api/queue.js';
import { LumoClient } from '../../src/lumo-client/index.js';
import { createMockProtonApi } from '../../src/mock/mock-api.js';
import { ConversationStore } from '../../src/conversations/store.js';
import { MetricsService, setMetrics } from '../../src/app/metrics.js';
import { createMetricsRouter, createMetricsMiddleware } from '../../src/api/metrics/index.js';
import type { EndpointDependencies } from '../../src/api/types.js';

interface TestServer {
  server: Server;
  baseUrl: string;
  metrics: MetricsService;
  close: () => Promise<void>;
}

async function createTestServerWithMetrics(): Promise<TestServer> {
  const mockApi = createMockProtonApi('success');
  const lumoClient = new LumoClient(mockApi, { enableEncryption: false });
  const store = new ConversationStore({ maxConversationsInMemory: 50 });
  const queue = new RequestQueue(1);

  const deps: EndpointDependencies = {
    queue,
    lumoClient,
    conversationStore: store,
    syncInitialized: false,
  };

  // Create metrics service with test prefix and set as singleton
  const metrics = new MetricsService({
    enabled: true,
    collectDefaultMetrics: false,
    prefix: 'lumo_',
  });
  setMetrics(metrics);

  const app = express();
  app.use(express.json());
  app.use(createMetricsMiddleware(metrics));
  app.use(createMetricsRouter(metrics));
  app.use(createHealthRouter(deps));
  app.use(createResponsesRouter(deps));

  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });

  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://localhost:${port}`;

  return {
    server,
    baseUrl,
    metrics,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

describe('GET /metrics', () => {
  let ts: TestServer;

  beforeAll(async () => {
    ts = await createTestServerWithMetrics();
  });

  afterAll(async () => {
    await ts.close();
    setMetrics(null);  // Clean up singleton
  });

  it('returns prometheus format metrics', async () => {
    const res = await fetch(`${ts.baseUrl}/metrics`);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');

    const body = await res.text();
    expect(body).toContain('# HELP');
    expect(body).toContain('# TYPE');
    expect(body).toContain('lumo_');
  });

  it('tracks HTTP requests after API calls', async () => {
    // Make a health check request
    await fetch(`${ts.baseUrl}/health`);

    // Check metrics
    const res = await fetch(`${ts.baseUrl}/metrics`);
    const body = await res.text();

    expect(body).toContain('lumo_http_requests_total');
    expect(body).toContain('endpoint="/health"');
    expect(body).toContain('method="GET"');
    expect(body).toContain('status="200"');
  });

  it('tracks request duration', async () => {
    // Make a request
    await fetch(`${ts.baseUrl}/health`);

    // Check metrics
    const res = await fetch(`${ts.baseUrl}/metrics`);
    const body = await res.text();

    expect(body).toContain('lumo_http_request_duration_seconds');
    expect(body).toContain('_bucket');
    expect(body).toContain('_sum');
    expect(body).toContain('_count');
  });

  it('tracks message counts for responses endpoint', async () => {
    // Make a responses request
    await fetch(`${ts.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'Hello world' }),
    });

    // Check metrics
    const res = await fetch(`${ts.baseUrl}/metrics`);
    const body = await res.text();

    expect(body).toContain('lumo_messages_total');
    expect(body).toContain('endpoint="/v1/responses"');
    expect(body).toContain('role="user"');
  });

  it('tracks streaming flag in request metrics', async () => {
    // Create a fresh server for this test to avoid metric contamination
    const freshServer = await createTestServerWithMetrics();

    try {
      // Make a non-streaming request
      await fetch(`${freshServer.baseUrl}/v1/responses`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: 'Hello', stream: false }),
      });

      // Make a streaming request and consume the response
      const streamRes = await fetch(`${freshServer.baseUrl}/v1/responses`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: 'Hello', stream: true }),
      });
      // Consume the stream to ensure the response completes
      await streamRes.text();

      // Check metrics
      const res = await fetch(`${freshServer.baseUrl}/metrics`);
      const body = await res.text();

      expect(body).toContain('streaming="false"');
      expect(body).toContain('streaming="true"');
    } finally {
      await freshServer.close();
      setMetrics(null);
    }
  });

  it('includes all expected metric types', async () => {
    const res = await fetch(`${ts.baseUrl}/metrics`);
    const body = await res.text();

    // Check that all our custom metrics are present
    expect(body).toContain('lumo_http_requests_total');
    expect(body).toContain('lumo_http_request_duration_seconds');
    expect(body).toContain('lumo_messages_total');
    expect(body).toContain('lumo_conversations_created_total');
    expect(body).toContain('lumo_tool_calls_total');
    expect(body).toContain('lumo_invalid_continuations_total');
    expect(body).toContain('lumo_request_queue_size');
    expect(body).toContain('lumo_sync_operations_total');
    expect(body).toContain('lumo_sync_duration_seconds');
    expect(body).toContain('lumo_auth_failures_total');
    expect(body).toContain('lumo_proton_api_requests_total');
    expect(body).toContain('lumo_proton_api_request_duration_seconds');
  });
});
