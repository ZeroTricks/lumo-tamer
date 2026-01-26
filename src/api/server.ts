import express from 'express';
import { getServerConfig, authConfig } from '../app/config.js';
import { resolveProjectPath } from '../app/paths.js';
import { logger } from '../app/logger.js';
import { setupAuthMiddleware, setupLoggingMiddleware } from './middleware.js';
import { createHealthRouter } from './routes/health.js';
import { createModelsRouter } from './routes/models.js';
import { createChatCompletionsRouter } from './routes/chat-completions.js';
import { createResponsesRouter } from './routes/responses/index.js';
import { createAuthRouter } from './routes/auth.js';
import { EndpointDependencies } from './types.js';
import { RequestQueue } from './queue.js';
import type { AppContext } from '../app/index.js';

export class APIServer {
  private expressApp: express.Application;
  private serverConfig = getServerConfig();
  private queue = new RequestQueue(1); // Process one request at a time

  constructor(private app: AppContext) {
    this.expressApp = express();
    this.setupMiddleware();
    this.setupRoutes();
  }

  private setupMiddleware(): void {
    this.expressApp.use(express.json());
    this.expressApp.use(setupAuthMiddleware(this.serverConfig.apiKey));
    this.expressApp.use(setupLoggingMiddleware());
  }

  private setupRoutes(): void {
    const deps = this.getDependencies();

    this.expressApp.use(createHealthRouter(deps));
    this.expressApp.use(createModelsRouter());
    this.expressApp.use(createChatCompletionsRouter(deps));
    this.expressApp.use(createResponsesRouter(deps));
    this.expressApp.use(createAuthRouter(deps));
  }

  private getDependencies(): EndpointDependencies {
    const tokenCachePath = resolveProjectPath(authConfig?.tokenCachePath ?? 'sessions/auth-tokens.json');

    return {
      queue: this.queue,
      lumoClient: this.app.getLumoClient(),
      conversationStore: this.app.getConversationStore(),
      syncInitialized: this.app.isSyncInitialized(),
      authManager: this.app.getAuthManager(),
      tokenCachePath,
    };
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.expressApp.listen(this.serverConfig.port, () => {
        logger.info('========================================');
        logger.info('Lumo Bridge is ready!');
        logger.info(`  base_url: http://localhost:${this.serverConfig.port}/v1`);
        logger.info(`  api_key:  ${this.serverConfig.apiKey.substring(0, 3)}...`);
        logger.info('========================================\n');
        resolve();
      });
    });
  }
}
