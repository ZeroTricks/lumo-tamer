/**
 * Shared types for the Application layer
 * TODO: merge with app/index.ts or see if more types can be moved here
 */

import type { LumoClient } from '../lumo-client/index.js';
import type { AuthProvider, AuthManager } from '../auth/index.js';
import type { ConversationStore, FallbackStore } from '../conversations/index.js';

/**
 * Application context exposed to CLI and API
 */
export interface AppContext {
  getLumoClient(): LumoClient;
  getConversationStore(): ConversationStore | FallbackStore;
  getAuthProvider(): AuthProvider | undefined;
  getAuthManager(): AuthManager | undefined;
  isSyncInitialized(): boolean;
  destroy(): void;
}
