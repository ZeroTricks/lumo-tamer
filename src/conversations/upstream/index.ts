/**
 * Upstream Storage Module
 *
 * Provides conversation persistence using Proton's upstream WebClient modules:
 * - Redux for in-memory state management
 * - IndexedDB (via indexeddbshim) for local persistence
 * - Sagas for automatic sync operations
 *
 * This module exports:
 * - UpstreamConversationStore: Drop-in replacement for ConversationStore
 * - initializeUpstreamStore: Setup function for the storage system
 */

export { UpstreamConversationStore } from './adapter.js';
export {
    initializeUpstreamStore,
    type UpstreamStoreConfig,
    type UpstreamStoreResult,
} from './init.js';
