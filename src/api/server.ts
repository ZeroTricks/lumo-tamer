import express from 'express';
import { BrowserManager } from '../browser/manager.js';
import { ChatboxInteractor } from '../browser/chatbox.js';
import { RequestQueue } from '../queue/manager.js';
import { serverConfig } from '../config.js';
import { logger } from '../logger.js';
import { setupAuthMiddleware, setupLoggingMiddleware } from './middleware.js';
import { createHealthRouter } from './routes/health.js';
import { createModelsRouter } from './routes/models.js';
import { createChatCompletionsRouter } from './routes/chat-completions.js';
import { createResponsesRouter } from './routes/responses.js';
import { EndpointDependencies } from './types.js';

export class APIServer {
  private app: express.Application;
  private browserManager: BrowserManager;
  private chatbox: ChatboxInteractor | null = null;
  private queue: RequestQueue;

  constructor(browserManager: BrowserManager) {
    this.app = express();
    this.browserManager = browserManager;
    this.queue = new RequestQueue(1); // Process one message at a time

    this.setupMiddleware();
    this.setupRoutes();
  }

  private setupMiddleware(): void {
    this.app.use(express.json());
    this.app.use(setupAuthMiddleware(serverConfig.apiKey));
    this.app.use(setupLoggingMiddleware());
  }

  private setupRoutes(): void {
    const deps = this.getDependencies();

    this.app.use(createHealthRouter(deps));
    this.app.use(createModelsRouter());
    this.app.use(createChatCompletionsRouter(deps));
    this.app.use(createResponsesRouter(deps));
  }

  private getDependencies(): EndpointDependencies {
    return {
      browserManager: this.browserManager,
      queue: this.queue,
      getChatbox: () => this.getChatbox(),
    };
  }

  private async getChatbox(): Promise<ChatboxInteractor> {
    if (!this.chatbox) {
      const page = await this.browserManager.getPage();
      this.chatbox = new ChatboxInteractor(page);
    }
    return this.chatbox;
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.app.listen(serverConfig.port, () => {
        logger.info('========================================');
        logger.info('✓ Lumo Bridge is ready!');
        logger.info(`  base_url: http://localhost:${serverConfig.port}/v1`);
        logger.info(`  api_key:  ${serverConfig.apiKey.substring(0,3)}...`);
        logger.info('========================================\n');
        resolve();
      });
    });
  }
}
