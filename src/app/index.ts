/**
 * Application - Shared initialization layer for CLI and API
 *
 * Handles authentication, persistence, and client setup once,
 * providing a unified context for both CLI and API modes.
 */

import { getConversationsConfig, authConfig, mockConfig } from './config.js';
import { logger } from './logger.js';
import { getVaultPath } from './paths.js';
import { LumoClient } from '../lumo-client/index.js';
import { createAuthProvider, AuthManager, type AuthProvider, type ProtonApi } from '../auth/index.js';
import { getConversationStore, setConversationStore, initializeConversationStore, type ConversationStore } from '../conversations/index.js';
import { createMockProtonApi } from '../mock/mock-api.js';
import { installFetchAdapter } from '../shims/fetch-adapter.js';
import { suppressFullApiErrors } from '../shims/console.js';

export class Application {
  private lumoClient!: LumoClient;
  private authProvider!: AuthProvider;
  private authManager!: AuthManager;
  private protonApi!: ProtonApi;
  private uid!: string;
  private syncInitialized = false;
  private cleanupFetchAdapter?: () => void;

  /**
   * Create and initialize the application
   */
  static async create(): Promise<Application> {
    const app = new Application();
    if (mockConfig.enabled) {
      await app.initializeMock();
    } else {
      await app.initializeAuth();
      await app.initializeStore();
    }
    return app;
  }

  /**
   * Initialize mock mode - bypass auth, use simulated API responses
   */
  private async initializeMock(): Promise<void> {
    // Install mock fetch adapter BEFORE store init (sagas make API calls)
    const { installMockFetchAdapter } = await import('../shims/fetch-adapter.js');
    this.cleanupFetchAdapter = installMockFetchAdapter();

    // Suppress API errors in logs (same as local-only mode)
    suppressFullApiErrors();

    // Use primary store with fake-indexeddb for mock mode
    const { initializeMockStore } = await import('../mock/mock-store.js');
    const result = await initializeMockStore();
    setConversationStore(result.conversationStore);

    this.protonApi = createMockProtonApi(mockConfig.scenario);
    this.lumoClient = new LumoClient(this.protonApi, { enableEncryption: false });

    logger.info({ scenario: mockConfig.scenario }, 'Mock mode active - auth and sync bypassed');
  }

  /**
   * Initialize authentication using AuthManager with auto-refresh
   */
  private async initializeAuth(): Promise<void> {
    this.authProvider = await createAuthProvider();

    // Create AuthManager with auto-refresh configuration
    const vaultPath = getVaultPath();
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

    // Install fetch adapter for upstream LumoApi
    // fullApiSupported is false for login/rclone auth (no lumo scope)
    const fullApiSupported = this.authProvider.supportsFullApi();
    this.cleanupFetchAdapter = installFetchAdapter(this.protonApi, fullApiSupported);

    // Configure console shim to suppress API errors when full api is not supported
    suppressFullApiErrors(!fullApiSupported);

    // Start scheduled auto-refresh
    this.authManager.startAutoRefresh();

    logger.info({ method: this.authProvider.method }, 'Authentication initialized with auto-refresh');
  }

  /**
   * Initialize conversation store (upstream or fallback in-memory)
   */
  private async initializeStore(): Promise<void> {
    const conversationsConfig = getConversationsConfig();
    await initializeConversationStore({
      protonApi: this.protonApi,
      uid: this.uid,
      authProvider: this.authProvider,
      conversationsConfig,
    });

    // Sync is enabled if config allows and auth provider supports it
    this.syncInitialized = conversationsConfig.enableSync && !this.authProvider.getSyncWarning();
  }

  // AppContext implementation

  getLumoClient(): LumoClient {
    return this.lumoClient;
  }

  getConversationStore(): ConversationStore | undefined {
    return getConversationStore();
  }

  getAuthProvider(): AuthProvider | undefined {
    return this.authProvider;
  }

  getAuthManager(): AuthManager | undefined {
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
    this.cleanupFetchAdapter?.();
  }
}

