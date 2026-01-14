/**
 * Sync module for conversation persistence
 *
 * Provides:
 * - LumoPersistenceClient for API communication
 * - SyncCoordinator for background synchronization
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
