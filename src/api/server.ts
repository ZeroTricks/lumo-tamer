import express from 'express';
import { RequestQueue } from '../queue/manager.js';
import { serverConfig, protonConfig, authConfig } from '../config.js';
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
import { AuthManager, parseRcloneConfig } from '../auth/index.js';

export class APIServer {
  private app: express.Application;
  private lumoClient!: SimpleLumoClient;
  private queue: RequestQueue;
  private authManager?: AuthManager;

  private constructor() {
    this.app = express();
    this.queue = new RequestQueue(1); // Process one message at a time
  }

  /**
   * Create and initialize the API server
   */
  static async create(): Promise<APIServer> {
    const server = new APIServer();
    await server.initializeAuth();
    server.setupMiddleware();
    server.setupRoutes();
    return server;
  }

  /**
   * Initialize authentication based on config
   */
  private async initializeAuth(): Promise<void> {
    const method = authConfig?.method ?? 'browser';

    if (method === 'srp' && authConfig) {
      logger.info('Using SRP authentication via go-proton-api');
      this.authManager = new AuthManager({
        method: 'srp',
        binaryPath: authConfig.binaryPath ?? './bin/proton-auth',
        tokenCachePath: authConfig.tokenCachePath ?? 'sessions/auth-tokens.json',
      });
      await this.authManager.initialize();

      const api = this.authManager.createApi();
      this.lumoClient = new SimpleLumoClient(api);
      logger.info('SRP authentication initialized');

    } else if (method === 'rclone' && authConfig) {
      const rclonePath = authConfig.rclonePath ?? '~/.config/rclone/rclone.conf';
      const remoteName = authConfig.rcloneRemote;

      if (!remoteName) {
        throw new Error('auth.rcloneRemote is required when using rclone auth method');
      }

      logger.info({ rclonePath, remoteName }, 'Using rclone authentication');
      const tokens = parseRcloneConfig(rclonePath, remoteName);

      logger.info({
        uid: tokens.uid.slice(0, 12) + '...',
        hasKeyPassword: !!tokens.keyPassword,
        extractedAt: tokens.extractedAt,
      }, 'Loaded tokens from rclone config');

      // Create API adapter using the SRP-style tokens
      // Reuse the same API creation logic as AuthManager
      const api = this.createApiFromTokens(tokens);
      this.lumoClient = new SimpleLumoClient(api);

    } else {
      // Legacy browser-based token loading
      logger.info({ tokenCachePath: authConfig.tokenCachePath }, 'Loading auth tokens (browser mode)');
      const tokens = loadAuthTokens();
      const tokenAge = getTokenAgeHours(tokens);
      logger.info({
        extractedAt: tokens.extractedAt,
        ageHours: tokenAge.toFixed(1),
        cookieCount: tokens.cookies.length,
      }, 'Tokens loaded');

      if (areTokensExpired(tokens)) {
        logger.warn('Some cookies have expired. Re-run extract-tokens if you get auth errors.');
      }

      const api = createApiAdapter(tokens);
      this.lumoClient = new SimpleLumoClient(api);
    }
  }

  /**
   * Create API adapter from SRP-style tokens (used by rclone)
   */
  private createApiFromTokens(tokens: { uid: string; accessToken: string }): ReturnType<typeof createApiAdapter> {
    const baseUrl = protonConfig.baseUrl;
    const appVersion = protonConfig.appVersion;

    return async (options) => {
      const url = `${baseUrl}/${options.url}`;

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'x-pm-uid': tokens.uid,
        'x-pm-appversion': appVersion,
        'Authorization': `Bearer ${tokens.accessToken}`,
      };

      if (options.output === 'stream') {
        headers['Accept'] = 'text/event-stream';
      }

      const fetchOptions: RequestInit = {
        method: options.method.toUpperCase(),
        headers,
        signal: options.signal,
      };

      if (options.data && options.method !== 'get') {
        fetchOptions.body = JSON.stringify(options.data);
      }

      const response = await fetch(url, fetchOptions);

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`API request failed: ${response.status} ${text}`);
      }

      if (options.output === 'stream') {
        return response.body!;
      }

      return response.json();
    };
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
