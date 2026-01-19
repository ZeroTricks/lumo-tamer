/**
 * Persistence module for conversation storage
 *
 * Provides:
 * - In-memory conversation store with LRU eviction
 * - Message deduplication for OpenAI API format
 * - Types compatible with Proton Lumo webclient
 */

// Types
export type {
    ConversationId,
    ConversationMetadata,
    ConversationPrivate,
    Conversation,
    ConversationState,
    ConversationStatus,
    Message,
    MessageId,
    MessagePrivate,
    MessagePublic,
    MessageRole,
    MessageStatus,
    MessageFingerprint,
    PendingChange,
    PersistenceConfig,
    SpaceId,
    RemoteId,
    IdMapEntry,
} from './types.js';

// Store
export {
    ConversationStore,
    getConversationStore,
    resetConversationStore,
} from './conversation-store.js';

// Deduplication utilities
export {
    hashMessage,
    createFingerprint,
    fingerprintMessages,
    findNewMessages,
    isValidContinuation,
    detectBranching,
    type IncomingMessage,
} from './deduplication.js';

// Session key utilities
export {
    decryptPersistedSession,
    canDecryptSession,
    getMailboxPassword,
} from './session-keys.js';

// Encryption / Key management
export {
    KeyManager,
    getKeyManager,
    resetKeyManager,
    type KeyManagerConfig,
} from './encryption/index.js';

// Server sync
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
    // Sync service
    SyncService,
    getSyncService,
    resetSyncService,
    type SyncServiceConfig,
} from './sync/index.js';
