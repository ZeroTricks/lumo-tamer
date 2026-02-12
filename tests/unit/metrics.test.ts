/**
 * Unit tests for MetricsService
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MetricsService } from '../../src/api/metrics/service.js';

describe('MetricsService', () => {
  let metrics: MetricsService;

  beforeEach(() => {
    // Create fresh instance for each test (no default metrics to keep output clean)
    metrics = new MetricsService({
      enabled: true,
      collectDefaultMetrics: false,
      prefix: 'test_',
    });
  });

  describe('httpRequestsTotal', () => {
    it('increments request counter', async () => {
      metrics.httpRequestsTotal.inc({
        endpoint: '/v1/responses',
        method: 'POST',
        status: '200',
        streaming: 'false',
      });

      const output = await metrics.getMetrics();
      expect(output).toContain('test_http_requests_total');
      expect(output).toContain('endpoint="/v1/responses"');
      expect(output).toContain('method="POST"');
      expect(output).toContain('status="200"');
      expect(output).toContain('streaming="false"');
    });

    it('tracks streaming requests separately', async () => {
      metrics.httpRequestsTotal.inc({
        endpoint: '/v1/responses',
        method: 'POST',
        status: '200',
        streaming: 'true',
      });
      metrics.httpRequestsTotal.inc({
        endpoint: '/v1/responses',
        method: 'POST',
        status: '200',
        streaming: 'false',
      });

      const output = await metrics.getMetrics();
      expect(output).toContain('streaming="true"');
      expect(output).toContain('streaming="false"');
    });
  });

  describe('httpRequestDuration', () => {
    it('observes request duration', async () => {
      metrics.httpRequestDuration.observe(
        { endpoint: '/v1/responses', method: 'POST' },
        0.5
      );

      const output = await metrics.getMetrics();
      expect(output).toContain('test_http_request_duration_seconds');
      expect(output).toContain('_bucket');
      expect(output).toContain('_sum');
      expect(output).toContain('_count');
    });
  });

  describe('messagesTotal', () => {
    it('counts messages by role', async () => {
      metrics.messagesTotal.inc({ endpoint: '/v1/responses', role: 'user' });
      metrics.messagesTotal.inc({ endpoint: '/v1/responses', role: 'user' });
      metrics.messagesTotal.inc({ endpoint: '/v1/responses', role: 'assistant' });

      const output = await metrics.getMetrics();
      expect(output).toContain('test_messages_total');
      expect(output).toContain('role="user"');
      expect(output).toContain('role="assistant"');
    });
  });

  describe('conversationsCreatedTotal', () => {
    it('counts conversation creations', async () => {
      metrics.conversationsCreatedTotal.inc();
      metrics.conversationsCreatedTotal.inc();

      const output = await metrics.getMetrics();
      expect(output).toContain('test_conversations_created_total 2');
    });
  });

  describe('toolCallsTotal', () => {
    it('tracks tool calls by type, status, and tool_name', async () => {
      metrics.toolCallsTotal.inc({ type: 'native', status: 'detected', tool_name: 'web_search' });
      metrics.toolCallsTotal.inc({ type: 'native', status: 'successful', tool_name: 'web_search' });
      metrics.toolCallsTotal.inc({ type: 'native', status: 'failed', tool_name: 'proton_info' });
      metrics.toolCallsTotal.inc({ type: 'custom', status: 'detected', tool_name: 'my_tool' });
      metrics.toolCallsTotal.inc({ type: 'custom', status: 'invalid', tool_name: 'unknown' });
      metrics.toolCallsTotal.inc({ type: 'misrouted', status: 'detected', tool_name: 'computer' });

      const output = await metrics.getMetrics();
      expect(output).toContain('test_tool_calls_total');
      expect(output).toContain('type="native"');
      expect(output).toContain('type="custom"');
      expect(output).toContain('type="misrouted"');
      expect(output).toContain('status="detected"');
      expect(output).toContain('status="successful"');
      expect(output).toContain('status="failed"');
      expect(output).toContain('status="invalid"');
      expect(output).toContain('tool_name="web_search"');
      expect(output).toContain('tool_name="proton_info"');
      expect(output).toContain('tool_name="my_tool"');
    });
  });

  describe('invalidContinuationsTotal', () => {
    it('counts invalid continuations', async () => {
      metrics.invalidContinuationsTotal.inc();

      const output = await metrics.getMetrics();
      expect(output).toContain('test_invalid_continuations_total 1');
    });
  });

  describe('requestQueueSize', () => {
    it('tracks queue size (gauge)', async () => {
      metrics.requestQueueSize.set(5);

      const output = await metrics.getMetrics();
      expect(output).toContain('test_request_queue_size 5');
    });

    it('gauge can decrease', async () => {
      metrics.requestQueueSize.set(5);
      metrics.requestQueueSize.set(2);

      const output = await metrics.getMetrics();
      expect(output).toContain('test_request_queue_size 2');
    });
  });

  describe('syncOperationsTotal', () => {
    it('tracks sync operations by status', async () => {
      metrics.syncOperationsTotal.inc({ status: 'success' });
      metrics.syncOperationsTotal.inc({ status: 'failure' });

      const output = await metrics.getMetrics();
      expect(output).toContain('test_sync_operations_total');
      expect(output).toContain('status="success"');
      expect(output).toContain('status="failure"');
    });
  });

  describe('syncDuration', () => {
    it('observes sync duration', async () => {
      metrics.syncDuration.observe(1.5);

      const output = await metrics.getMetrics();
      expect(output).toContain('test_sync_duration_seconds');
    });
  });

  describe('authFailuresTotal', () => {
    it('counts auth failures', async () => {
      metrics.authFailuresTotal.inc();

      const output = await metrics.getMetrics();
      expect(output).toContain('test_auth_failures_total 1');
    });
  });

  describe('getContentType', () => {
    it('returns prometheus content type', () => {
      const contentType = metrics.getContentType();
      expect(contentType).toContain('text/plain');
    });
  });

  describe('getMetrics', () => {
    it('returns valid prometheus format', async () => {
      metrics.httpRequestsTotal.inc({
        endpoint: '/health',
        method: 'GET',
        status: '200',
        streaming: 'false',
      });

      const output = await metrics.getMetrics();

      // Should have HELP and TYPE comments
      expect(output).toContain('# HELP');
      expect(output).toContain('# TYPE');
      expect(output).toContain('counter');
    });
  });
});
