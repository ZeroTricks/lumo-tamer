import express from 'express';
import { serverConfig } from '../config.js';
import { logger } from '../logger.js';
import { setupAuthMiddleware, setupLoggingMiddleware } from './middleware.js';
import { createHealthRouter } from './routes/health.js';
import { createModelsRouter } from './routes/models.js';
import { createChatCompletionsRouter } from './routes/chat-completions.js';
import { createResponsesRouter } from './routes/responses/index.js';
import { EndpointDependencies } from './types.js';
import type { AppContext } from '../app/index.js';

export class APIServer {
  private expressApp: express.Application;

  constructor(private app: AppContext) {
    this.expressApp = express();
    this.setupMiddleware();
    this.setupRoutes();
  }

  private setupMiddleware(): void {
    this.expressApp.use(express.json());
    this.expressApp.use(setupAuthMiddleware(serverConfig.apiKey));
    this.expressApp.use(setupLoggingMiddleware());
  }

  private setupRoutes(): void {
    const deps = this.getDependencies();

    this.expressApp.use(createHealthRouter(deps));
    this.expressApp.use(createModelsRouter());
    this.expressApp.use(createChatCompletionsRouter(deps));
    this.expressApp.use(createResponsesRouter(deps));
  }

  private getDependencies(): EndpointDependencies {
    return {
      queue: this.app.getQueue(),
      getLumoClient: () => this.app.getLumoClient(),
      conversationStore: this.app.getConversationStore(),
      syncInitialized: this.app.isSyncInitialized(),
    };
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.expressApp.listen(serverConfig.port, () => {
        logger.info('========================================');
        logger.info('Lumo Bridge is ready!');
        logger.info(`  base_url: http://localhost:${serverConfig.port}/v1`);
        logger.info(`  api_key:  ${serverConfig.apiKey.substring(0, 3)}...`);
        logger.info('========================================\n');
        resolve();
      });
    });
  }
}
