/**
 * Conversation persistence module
 *
 * Provides:
 * - ConversationStore: Redux + IndexedDB storage
 * - Message deduplication for OpenAI API format
 * - Types compatible with Proton Lumo webclient
 */

// Types
export type {
    ConversationId,
    ConversationPriv,
    Conversation,
    ConversationState,
    Message,
    MessageId,
    MessagePriv,
    SpaceId,
    RemoteId,
    IdMapEntry,
    MessageForStore,
    InitializeStoreOptions,
} from './types.js';

// Store
export { ConversationStore } from './store.js';

// Initialization and singleton management
export {
    initializeConversationStore,
    getConversationStore,
    setConversationStore,
    resetConversationStore,
} from './init.js';

// Key management (exported for testing)
export {
    KeyManager,
    getKeyManager,
    resetKeyManager,
    type KeyManagerConfig,
} from './key-manager.js';
