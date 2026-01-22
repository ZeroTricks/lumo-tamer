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
  type Api,
} from '../lumo-client/index.js';
import { AuthManager, parseRcloneConfig } from '../auth/index.js';
import { getConversationStore } from 'persistence/conversation-store.js';
import {
  LumoPersistenceClient,
  getSyncService,
  getKeyManager,
  decryptPersistedSession,
} from 'persistence/index.js';
import { persistenceConfig } from '../config.js';

export class APIServer {
  private app: express.Application;
  private lumoClient!: SimpleLumoClient;
  private queue: RequestQueue;
  private authManager?: AuthManager;
  private lumoPersistenceClient!: LumoPersistenceClient;
  private api!: Api;
  private syncInitialized = false;
  private browserKeyPassword?: string;
  private browserUserKeys?: Array<{ ID: string; PrivateKey: string; Primary: number; Active: number }>;
  private browserMasterKeys?: Array<{ ID: string; MasterKey: string; IsLatest: boolean; Version: number }>;

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
   * Initialize authentication based on config
   */
  private async initializeAuth(): Promise<void> {
    const method = authConfig?.method ?? 'browser';

    // TODO: get rid of hardcoded defaults. relevant parameters should be required
    if (method === 'srp' && authConfig) {
      logger.info('Using SRP authentication via go-proton-api');
      this.authManager = new AuthManager({
        method: 'srp',
        binaryPath: authConfig.binaryPath ?? './bin/proton-auth',
        tokenCachePath: authConfig.tokenCachePath ?? 'sessions/auth-tokens.json',
      });
      await this.authManager.initialize();

      this.api = this.authManager.createApi();
      this.lumoClient = new SimpleLumoClient(this.api);
      this.lumoPersistenceClient = new LumoPersistenceClient(this.api);

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
      this.api = this.createApiFromTokens(tokens);
      this.lumoClient = new SimpleLumoClient(this.api);
      this.lumoPersistenceClient = new LumoPersistenceClient(this.api);

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

      this.api = createApiAdapter(tokens);
      this.lumoClient = new SimpleLumoClient(this.api);
      this.lumoPersistenceClient = new LumoPersistenceClient(this.api);

      // Try to extract keyPassword from persisted session
      if (tokens.persistedSession?.blob && tokens.persistedSession?.clientKey) {
        try {
          const decrypted = await decryptPersistedSession(tokens.persistedSession);
          this.browserKeyPassword = decrypted.keyPassword;
          logger.info('Extracted keyPassword from browser session');
        } catch (err) {
          logger.warn({ err }, 'Failed to decrypt browser session - keyPassword unavailable');
        }
      } else {
        logger.debug({
          hasBlob: !!tokens.persistedSession?.blob,
          hasClientKey: !!tokens.persistedSession?.clientKey,
        }, 'Browser session missing blob or clientKey - keyPassword unavailable');
      }

      // Store cached user keys if available (bypasses core/v4/users scope issue)
      if (tokens.userKeys && tokens.userKeys.length > 0) {
        this.browserUserKeys = tokens.userKeys;
        logger.info({ keyCount: tokens.userKeys.length }, 'Loaded cached user keys from tokens');
      }

      // Store cached master keys if available (bypasses lumo/v1/masterkeys scope issue)
      if (tokens.masterKeys && tokens.masterKeys.length > 0) {
        this.browserMasterKeys = tokens.masterKeys;
        logger.info({ keyCount: tokens.masterKeys.length }, 'Loaded cached master keys from tokens');
      }
    }
  }

  /**
   * Initialize sync service for conversation persistence
   * Requires KeyManager to be initialized with mailbox password
   */
  private async initializeSync(): Promise<void> {
    if (!persistenceConfig?.enabled) {
      logger.info('Persistence is disabled, skipping sync initialization');
      return;
    }

    // Get keyPassword from whichever auth method has it
    let keyPassword: string | undefined;
    let source: string | undefined;

    if (authConfig.method === 'rclone' && authConfig.rcloneRemote) {
      try {
        const rclonePath = authConfig.rclonePath ?? '~/.config/rclone/rclone.conf';
        const tokens = parseRcloneConfig(rclonePath, authConfig.rcloneRemote);
        keyPassword = tokens.keyPassword;
        source = 'rclone';
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error({ errorMessage }, 'Failed to parse rclone config');
      }
    } else if (authConfig.method === 'browser' && this.browserKeyPassword) {
      keyPassword = this.browserKeyPassword;
      source = 'browser';
    } else if (authConfig.method === 'srp' && this.authManager) {
      keyPassword = this.authManager.getKeyPassword();
      source = 'srp';
    }

    if (!keyPassword) {
      logger.info({ method: authConfig.method }, 'No keyPassword available - sync will not be initialized');
      return;
    }

    try {
      logger.info({ source, hasCachedUserKeys: !!this.browserUserKeys, hasCachedMasterKeys: !!this.browserMasterKeys }, 'Initializing KeyManager with keyPassword...');

      // Initialize KeyManager (pass cached keys if available to bypass scope issues)
      const keyManager = getKeyManager({
        api: this.api,
        cachedUserKeys: this.browserUserKeys,
        cachedMasterKeys: this.browserMasterKeys,
      });

      await keyManager.initialize(keyPassword);

      // Initialize SyncService
      const syncService = getSyncService({
        api: this.lumoPersistenceClient,
        keyManager,
        defaultSpaceName: persistenceConfig.defaultSpaceName,
        spaceId: persistenceConfig.spaceId,
      });

      // Mark as initialized now - commands like deleteAllSpaces should work
      // even if ensureSpace fails
      this.syncInitialized = true;

      // Eagerly fetch/create space so we see available spaces at startup
      try {
        await syncService.ensureSpace();
        logger.info({ source }, 'Sync service initialized successfully');
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

  /**
   * Create API adapter from SRP-style tokens (used by rclone)
   */
  // TODO: move to api-adapter.ts
  // TODO: refactor and share common code with createApiAdapter
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
