/**
 * Sync module for conversation persistence
 *
 * Provides:
 * - LumoApi via adapter for API communication (from upstream WebClient)
 * - SyncService for on-demand synchronization
 */

export {
    SyncService,
    getSyncService,
    resetSyncService,
    type SyncServiceConfig,
} from './sync-service.js';

// Encryption codec
export { EncryptionCodec } from './encryption-codec.js';

// Space manager (for external use if needed)
export {
    SpaceManager,
    type SpaceManagerConfig,
    type SpaceContext,
} from './space-manager.js';

// Auto-sync
export {
    AutoSyncService,
    getAutoSyncService,
    resetAutoSyncService,
} from './auto-sync.js';

// Re-export LumoApi and types from upstream
export { LumoApi } from '@lumo/remote/api.js';
export type { Priority } from '@lumo/remote/scheduler.js';
export {
    RoleInt,
    StatusInt,
} from '@lumo/remote/types.js';
export type {
    ListSpacesRemote,
    GetSpaceRemote,
    GetConversationRemote,
    RemoteMessage,
    RemoteSpace,
    RemoteConversation,
} from '@lumo/remote/types.js';
