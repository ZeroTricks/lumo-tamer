import express from 'express';
import { RequestQueue } from '../queue/manager.js';
import { serverConfig, protonConfig } from '../config.js';
import { logger } from '../logger.js';
import { setupAuthMiddleware, setupLoggingMiddleware } from './middleware.js';
import { createHealthRouter } from './routes/health.js';
import { createModelsRouter } from './routes/models.js';
import { createChatCompletionsRouter } from './routes/chat-completions.js';
import { createResponsesRouter } from './routes/responses/index.js';
import { EndpointDependencies } from './types.js';
import {
  SimpleLumoClient,
  createApiAdapter,
  loadAuthTokens,
  getTokenAgeHours,
  areTokensExpired,
} from '../lumo-client/index.js';

export class APIServer {
  private app: express.Application;
  private lumoClient: SimpleLumoClient;
  private queue: RequestQueue;

  constructor() {
    this.app = express();
    this.queue = new RequestQueue(1); // Process one message at a time

    // Initialize Lumo client with auth tokens
    logger.info({ tokensPath: protonConfig.tokensPath }, 'Loading auth tokens');
    const tokens = loadAuthTokens();
    const tokenAge = getTokenAgeHours(tokens);
    logger.info({
      extractedAt: tokens.extractedAt,
      ageHours: tokenAge.toFixed(1),
      cookieCount: tokens.cookies.length,
    }, 'Tokens loaded');

    if (areTokensExpired(tokens)) {
      logger.warn('Some cookies have expired. Re-run extract-token if you get auth errors.');
    }

    const api = createApiAdapter(tokens);
    this.lumoClient = new SimpleLumoClient(api);

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
      queue: this.queue,
      getLumoClient: () => this.lumoClient,
    };
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.app.listen(serverConfig.port, () => {
        logger.info('========================================');
        logger.info('Lumo Bridge is ready!');
        logger.info(`  base_url: http://localhost:${serverConfig.port}/v1`);
        logger.info(`  api_key:  ${serverConfig.apiKey.substring(0,3)}...`);
        logger.info('========================================\n');
        resolve();
      });
    });
  }
}
