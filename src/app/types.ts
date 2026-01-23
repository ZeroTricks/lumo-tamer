/**
 * Shared types for the Application layer
 */

import type { RequestQueue } from './queue.js';
import type { LumoClient } from '../lumo-client/index.js';
import type { AuthProvider } from '../auth/index.js';
import type { ConversationStore } from '../persistence/conversation-store.js';

/**
 * Application context exposed to CLI and API
 */
export interface AppContext {
  getLumoClient(): LumoClient;
  getQueue(): RequestQueue;
  getConversationStore(): ConversationStore;
  getAuthProvider(): AuthProvider;
  isSyncInitialized(): boolean;
}
