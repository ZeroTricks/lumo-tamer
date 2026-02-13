import express from 'express';
import { getServerConfig, getMetricsConfig, authConfig } from '../app/config.js';
import { resolveProjectPath } from '../app/paths.js';
import { logger } from '../app/logger.js';
import { setupAuthMiddleware, setupLoggingMiddleware } from './middleware.js';
import { createHealthRouter } from './routes/health.js';
import { createModelsRouter } from './routes/models.js';
import { createChatCompletionsRouter } from './routes/chat-completions/index.js';
import { createResponsesRouter } from './routes/responses/index.js';
import { createAuthRouter } from './routes/auth.js';
import { EndpointDependencies } from './types.js';
import { RequestQueue } from './queue.js';
import { initMetrics, createMetricsMiddleware, createMetricsRouter, type MetricsService } from './metrics/index.js';
import type { AppContext } from '../app/index.js';

export class APIServer {
  private expressApp: express.Application;
  private serverConfig = getServerConfig();
  private queue = new RequestQueue(1); // Process one request at a time
  private metrics: MetricsService | null = null;

  constructor(private app: AppContext) {
    this.expressApp = express();
    const metricsConfig = getMetricsConfig();
    if (metricsConfig.enabled) {
      this.metrics = initMetrics(metricsConfig);
    }
    this.setupMiddleware();
    this.setupRoutes();
  }

  private setupMiddleware(): void {
    this.expressApp.use(express.json({ limit: '10mb' }));
    this.expressApp.use(setupAuthMiddleware(this.serverConfig.apiKey));
    this.expressApp.use(setupLoggingMiddleware());
    if (this.metrics) {
      this.expressApp.use(createMetricsMiddleware(this.metrics));
    }
  }

  private setupRoutes(): void {
    const deps = this.getDependencies();

    // Metrics endpoint (no auth required, like /health)
    if (this.metrics) {
      this.expressApp.use(createMetricsRouter(this.metrics));
    }

    this.expressApp.use(createHealthRouter(deps));
    this.expressApp.use(createModelsRouter());
    this.expressApp.use(createChatCompletionsRouter(deps));
    this.expressApp.use(createResponsesRouter(deps));
    this.expressApp.use(createAuthRouter(deps));
  }

  private getDependencies(): EndpointDependencies {
    const vaultPath = resolveProjectPath(authConfig.vault.path);

    return {
      queue: this.queue,
      lumoClient: this.app.getLumoClient(),
      conversationStore: this.app.getConversationStore(),
      syncInitialized: this.app.isSyncInitialized(),
      authManager: this.app.getAuthManager(),
      vaultPath,
    };
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.expressApp.listen(this.serverConfig.port, () => {
        logger.info('========================================');
        logger.info('lumo-tamer is ready!');
        logger.info(`  base_url: http://localhost:${this.serverConfig.port}/v1`);
        logger.info(`  api_key:  ${this.serverConfig.apiKey.substring(0, 3)}...`);
        logger.info('========================================\n');
        resolve();
      });
    });
  }
}
