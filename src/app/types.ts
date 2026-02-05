/**
 * Shared types for the Application layer
 */

import type { LumoClient } from '../lumo-client/index.js';
import type { AuthProvider, AuthManager } from '../auth/index.js';
import type { ConversationStore } from '../conversations/store.js';

/**
 * Application context exposed to CLI and API
 */
export interface AppContext {
  getLumoClient(): LumoClient;
  getConversationStore(): ConversationStore;
  getAuthProvider(): AuthProvider | undefined;
  getAuthManager(): AuthManager | undefined;
  isSyncInitialized(): boolean;
  destroy(): void;
}
