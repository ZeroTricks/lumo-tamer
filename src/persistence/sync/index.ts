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

// Re-export LumoApi adapter and types
export {
    LumoApi,
    createLumoApi,
    cleanupLumoApi,
    RoleInt,
    StatusInt,
    type Priority,
    type ListSpacesRemote,
    type GetSpaceRemote,
    type GetConversationRemote,
    type RemoteMessage,
    type RemoteSpace,
    type RemoteConversation,
} from './lumo-api-adapter.js';
