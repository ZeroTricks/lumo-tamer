/**
 * Upstream Storage Module
 *
 * Provides conversation persistence using Proton's upstream WebClient modules:
 * - Redux for in-memory state management
 * - IndexedDB (via indexeddbshim) for local persistence
 * - Sagas for async sync operations (pending adapter layer)
 *
 * This module exports:
 * - UpstreamConversationStore: Drop-in replacement for ConversationStore
 * - UpstreamSyncService: Drop-in replacement for SyncService
 * - initializeUpstreamStore: Setup function for the storage system
 */

export { UpstreamConversationStore } from './adapter.js';
export {
    UpstreamSyncService,
    type UpstreamSyncServiceConfig,
} from './sync-adapter.js';
export {
    initializeUpstreamStore,
    cleanupUpstreamStore,
    type UpstreamStoreConfig,
    type UpstreamStoreResult,
} from './init.js';
