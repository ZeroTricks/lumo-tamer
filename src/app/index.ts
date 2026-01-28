/**
 * Application - Shared initialization layer for CLI and API
 *
 * Handles authentication, persistence, and client setup once,
 * providing a unified context for both CLI and API modes.
 */

import { getConversationsConfig, authConfig } from './config.js';
import { logger } from './logger.js';
import { resolveProjectPath } from './paths.js';
import { LumoClient } from '../lumo-client/index.js';
import { createAuthProvider, AuthManager, type AuthProvider, type ProtonApi } from '../auth/index.js';
import { getConversationStore, type ConversationStore, initializeSync } from '../conversations/index.js';
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
    // Initialize conversation store with config (must happen before any getConversationStore() calls)
    const conversationsConfig = getConversationsConfig();
    getConversationStore({ maxConversationsInMemory: conversationsConfig.maxInMemory });

    this.authProvider = await createAuthProvider();

    // Create AuthManager with auto-refresh configuration
    const vaultPath = resolveProjectPath(authConfig.vault.path);
    const autoRefreshConfig = authConfig.autoRefresh;

    this.authManager = new AuthManager({
      provider: this.authProvider,
      vaultPath,
      autoRefresh: {
        enabled: autoRefreshConfig.enabled,
        intervalHours: autoRefreshConfig.intervalHours,
        onError: autoRefreshConfig.onError,
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
    const conversationsConfig = getConversationsConfig();
    const result = await initializeSync({
      protonApi: this.protonApi,
      uid: this.uid,
      authProvider: this.authProvider,
      conversationsConfig,
    });
    this.syncInitialized = result.initialized;
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
