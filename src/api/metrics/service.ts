// Metrics service using prom-client
// Provides Prometheus-compatible metrics for monitoring
import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from 'prom-client';

export interface MetricsConfig {
  enabled: boolean;
  collectDefaultMetrics: boolean;
  prefix: string;
}

export class MetricsService {
  private registry: Registry;

  // HTTP metrics
  readonly httpRequestsTotal: Counter;
  readonly httpRequestDuration: Histogram;

  // Message metrics
  readonly messagesTotal: Counter;

  // Conversation metrics
  readonly conversationsCreatedTotal: Counter;

  // Tool call metrics
  readonly toolCallsTotal: Counter;

  // Error/warning metrics
  readonly errorsTotal: Counter;
  readonly warningsTotal: Counter;

  // Continuation metrics
  readonly invalidContinuationsTotal: Counter;

  // Queue metrics
  readonly requestQueueSize: Gauge;

  // Sync metrics
  readonly syncOperationsTotal: Counter;
  readonly syncDuration: Histogram;

  // Auth metrics
  readonly authFailuresTotal: Counter;

  constructor(config: MetricsConfig) {
    this.registry = new Registry();
    const prefix = config.prefix;

    if (config.collectDefaultMetrics) {
      collectDefaultMetrics({ register: this.registry, prefix });
    }

    // HTTP metrics
    this.httpRequestsTotal = new Counter({
      name: `${prefix}http_requests_total`,
      help: 'Total HTTP requests',
      labelNames: ['endpoint', 'method', 'status', 'streaming'],
      registers: [this.registry],
    });

    this.httpRequestDuration = new Histogram({
      name: `${prefix}http_request_duration_seconds`,
      help: 'HTTP request duration in seconds',
      labelNames: ['endpoint', 'method'],
      buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60],
      registers: [this.registry],
    });

    // Message metrics
    this.messagesTotal = new Counter({
      name: `${prefix}messages_total`,
      help: 'Total messages processed',
      labelNames: ['endpoint', 'role'],
      registers: [this.registry],
    });

    // Conversation metrics
    this.conversationsCreatedTotal = new Counter({
      name: `${prefix}conversations_created_total`,
      help: 'Total conversations created',
      registers: [this.registry],
    });

    // Tool call metrics
    this.toolCallsTotal = new Counter({
      name: `${prefix}tool_calls_total`,
      help: 'Total tool calls',
      labelNames: ['type', 'status', 'tool_name'],
      registers: [this.registry],
    });

    // Error/warning metrics
    this.errorsTotal = new Counter({
      name: `${prefix}errors_total`,
      help: 'Total errors logged',
      labelNames: ['type'],
      registers: [this.registry],
    });

    this.warningsTotal = new Counter({
      name: `${prefix}warnings_total`,
      help: 'Total warnings logged',
      labelNames: ['type'],
      registers: [this.registry],
    });

    // Continuation metrics
    this.invalidContinuationsTotal = new Counter({
      name: `${prefix}invalid_continuations_total`,
      help: 'Invalid conversation continuations',
      registers: [this.registry],
    });

    // Queue metrics
    this.requestQueueSize = new Gauge({
      name: `${prefix}request_queue_size`,
      help: 'Current request queue size',
      registers: [this.registry],
    });

    // Sync metrics
    this.syncOperationsTotal = new Counter({
      name: `${prefix}sync_operations_total`,
      help: 'Sync operations by status',
      labelNames: ['status'],
      registers: [this.registry],
    });

    this.syncDuration = new Histogram({
      name: `${prefix}sync_duration_seconds`,
      help: 'Sync operation duration in seconds',
      buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
      registers: [this.registry],
    });

    // Auth metrics
    this.authFailuresTotal = new Counter({
      name: `${prefix}auth_failures_total`,
      help: 'Authentication failures',
      registers: [this.registry],
    });
  }

  async getMetrics(): Promise<string> {
    return this.registry.metrics();
  }

  getContentType(): string {
    return this.registry.contentType;
  }
}

// Singleton instance
let metricsInstance: MetricsService | null = null;

export function initMetrics(config: MetricsConfig): MetricsService {
  if (!config.enabled) {
    return null as unknown as MetricsService;
  }
  metricsInstance = new MetricsService(config);
  return metricsInstance;
}

export function getMetrics(): MetricsService | null {
  return metricsInstance;
}

/**
 * Set the metrics instance directly (for testing)
 */
export function setMetrics(metrics: MetricsService | null): void {
  metricsInstance = metrics;
}
