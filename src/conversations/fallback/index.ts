/**
 * Fallback Storage Module
 *
 * Provides in-memory conversation storage with optional server sync.
 * Used when the primary ConversationStore (Redux + IndexedDB) cannot be used.
 *
 * @deprecated This module will be removed in a future version.
 * Use the primary ConversationStore when possible.
 */

// Store
export {
    FallbackStore,
    getFallbackStore,
    resetFallbackStore,
} from './store.js';

// Sync services
export {
    SyncService,
    getSyncService,
    resetSyncService,
    type SyncServiceConfig,
} from './sync/index.js';

export {
    AutoSyncService,
    getAutoSyncService,
    resetAutoSyncService,
} from './sync/index.js';

export {
    SpaceManager,
    type SpaceManagerConfig,
    type SpaceContext,
} from './sync/index.js';

export { EncryptionCodec } from './sync/index.js';
