import express from 'express';
import { RequestQueue } from '../queue/manager.js';
import { serverConfig, persistenceConfig } from '../config.js';
import { logger } from '../logger.js';
import { setupAuthMiddleware, setupLoggingMiddleware } from './middleware.js';
import { createHealthRouter } from './routes/health.js';
import { createModelsRouter } from './routes/models.js';
import { createChatCompletionsRouter } from './routes/chat-completions.js';
import { createResponsesRouter } from './routes/responses/index.js';
import { EndpointDependencies } from './types.js';
import { SimpleLumoClient } from '../lumo-client/index.js';
import { createAuthProvider, type AuthProvider, type ProtonApi } from '../auth/index.js';
import { getConversationStore } from 'persistence/conversation-store.js';
import { getSyncService, getKeyManager } from 'persistence/index.js';

export class APIServer {
  private app: express.Application;
  private lumoClient!: SimpleLumoClient;
  private queue: RequestQueue;
  private authProvider!: AuthProvider;
  private protonApi!: ProtonApi;
  private uid!: string;
  private syncInitialized = false;

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
    await server.initializeSync();
    server.setupMiddleware();
    server.setupRoutes();
    return server;
  }

  /**
   * Initialize authentication using the unified auth provider
   */
  private async initializeAuth(): Promise<void> {
    this.authProvider = await createAuthProvider();
    this.protonApi = this.authProvider.createApi();
    this.uid = this.authProvider.getUid();
    this.lumoClient = new SimpleLumoClient(this.protonApi);

    logger.info({ method: this.authProvider.method }, 'Authentication initialized');
  }

  /**
   * Initialize sync service for conversation persistence
   */
  private async initializeSync(): Promise<void> {
    if (!persistenceConfig?.enabled) {
      logger.info('Persistence is disabled, skipping sync initialization');
      return;
    }

    const keyPassword = this.authProvider.getKeyPassword();
    if (!keyPassword) {
      logger.info({ method: this.authProvider.method }, 'No keyPassword available - sync will not be initialized');
      return;
    }

    try {
      // Get cached keys from browser provider if available
      const cachedUserKeys = this.authProvider.getCachedUserKeys?.();
      const cachedMasterKeys = this.authProvider.getCachedMasterKeys?.();

      logger.info({
        method: this.authProvider.method,
        hasCachedUserKeys: !!cachedUserKeys,
        hasCachedMasterKeys: !!cachedMasterKeys,
      }, 'Initializing KeyManager with keyPassword...');

      // Initialize KeyManager
      const keyManager = getKeyManager({
        protonApi: this.protonApi,
        cachedUserKeys,
        cachedMasterKeys,
      });

      await keyManager.initialize(keyPassword);

      // Initialize SyncService
      const syncService = getSyncService({
        protonApi: this.protonApi,
        uid: this.uid,
        keyManager,
        defaultSpaceName: persistenceConfig.defaultSpaceName,
        spaceId: persistenceConfig.spaceId,
        saveSystemMessages: persistenceConfig.saveSystemMessages,
      });

      this.syncInitialized = true;

      // Eagerly fetch/create space
      try {
        await syncService.ensureSpace();
        logger.info({ method: this.authProvider.method }, 'Sync service initialized successfully');
      } catch (spaceError) {
        const msg = spaceError instanceof Error ? spaceError.message : String(spaceError);
        logger.warn({ error: msg }, 'ensureSpace failed, but sync service is still available for commands');
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;
      logger.error({ errorMessage, errorStack }, 'Failed to initialize sync service');
    }
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
      conversationStore: getConversationStore(),
      syncInitialized: this.syncInitialized,
    };
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.app.listen(serverConfig.port, () => {
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
