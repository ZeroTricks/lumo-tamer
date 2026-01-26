/**
 * Application - Shared initialization layer for CLI and API
 *
 * Handles authentication, persistence, and client setup once,
 * providing a unified context for both CLI and API modes.
 */

import { getPersistenceConfig, authConfig } from './config.js';
import { logger } from './logger.js';
import { resolveProjectPath } from './paths.js';
import { LumoClient } from '../lumo-client/index.js';
import { createAuthProvider, AuthManager, type AuthProvider, type ProtonApi } from '../auth/index.js';
import { getConversationStore, type ConversationStore } from '../persistence/conversation-store.js';
import { getSyncService, getKeyManager, getAutoSyncService } from '../persistence/index.js';
import type { AppContext } from './types.js';

export class Application implements AppContext {
  private lumoClient!: LumoClient;
  private authProvider!: AuthProvider;
  private authManager!: AuthManager;
  private protonApi!: ProtonApi;
  private uid!: string;
  private syncInitialized = false;

  /**
   * Create and initialize the application
   */
  static async create(): Promise<Application> {
    const app = new Application();
    await app.initializeAuth();
    await app.initializeSync();
    return app;
  }

  /**
   * Initialize authentication using AuthManager with auto-refresh
   */
  private async initializeAuth(): Promise<void> {
    this.authProvider = await createAuthProvider();

    // Create AuthManager with auto-refresh configuration
    const tokenCachePath = resolveProjectPath(authConfig.tokenPath);
    const autoRefreshConfig = authConfig?.autoRefresh;

    this.authManager = new AuthManager({
      provider: this.authProvider,
      tokenCachePath,
      autoRefresh: {
        enabled: autoRefreshConfig?.enabled ?? true,
        intervalHours: autoRefreshConfig?.intervalHours ?? 20,
        onError: autoRefreshConfig?.onError ?? true,
      },
    });

    // Create API with 401 refresh handling
    this.protonApi = this.authManager.createApi();
    this.uid = this.authProvider.getUid();
    this.lumoClient = new LumoClient(this.protonApi);

    // Start scheduled auto-refresh
    this.authManager.startAutoRefresh();

    logger.info({ method: this.authProvider.method }, 'Authentication initialized with auto-refresh');
  }

  /**
   * Initialize sync service for conversation persistence
   */
  private async initializeSync(): Promise<void> {
    const persistenceConfig = getPersistenceConfig();
    if (!persistenceConfig?.enabled) {
      logger.info('Persistence is disabled, skipping sync initialization');
      return;
    }

    if (!this.authProvider.supportsPersistence()) {
      logger.warn(
        { method: this.authProvider.method },
        'Persistence requires browser auth (SRP/rclone tokens lack lumo scope for spaces API)'
      );
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

      // Initialize auto-sync if enabled
      const autoSyncConfig = persistenceConfig.autoSync;
      if (autoSyncConfig?.enabled) {
        const autoSync = getAutoSyncService(syncService, {
          enabled: true,
          debounceMs: autoSyncConfig.debounceMs,
          minIntervalMs: autoSyncConfig.minIntervalMs,
          maxDelayMs: autoSyncConfig.maxDelayMs,
        });

        // Connect to conversation store
        const store = getConversationStore();
        store.setOnDirtyCallback(() => autoSync.notifyDirty());

        logger.info('Auto-sync enabled and connected to conversation store');
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;
      logger.error({ errorMessage, errorStack }, 'Failed to initialize sync service');
    }
  }

  // AppContext implementation

  getLumoClient(): LumoClient {
    return this.lumoClient;
  }

  getConversationStore(): ConversationStore {
    return getConversationStore();
  }

  getAuthProvider(): AuthProvider {
    return this.authProvider;
  }

  getAuthManager(): AuthManager {
    return this.authManager;
  }

  isSyncInitialized(): boolean {
    return this.syncInitialized;
  }

  /**
   * Cleanup resources on shutdown
   */
  destroy(): void {
    this.authManager?.destroy();
  }
}

export type { AppContext } from './types.js';
