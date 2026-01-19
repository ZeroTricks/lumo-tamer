/**
 * Sync module for conversation persistence
 *
 * Provides:
 * - LumoPersistenceClient for API communication
 * - SyncService for on-demand synchronization
 */

export {
    LumoPersistenceClient,
    RoleToInt,
    IntToRole,
    StatusToInt,
    type CreateSpaceRequest,
    type CreateConversationRequest,
    type UpdateConversationRequest,
    type CreateMessageRequest,
    type SpaceFromApi,
    type ConversationFromApi,
    type MessageFromApi,
    type GetSpaceResponse,
    type GetConversationResponse,
} from './server-client.js';

export {
    SyncService,
    getSyncService,
    resetSyncService,
    type SyncServiceConfig,
} from './sync-service.js';
