/**
 * Conversation persistence module
 *
 * Provides:
 * - ConversationStore: Primary storage using Redux + IndexedDB
 * - MinimalStore: Lightweight in-memory storage for CLI/tests
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
} from './types.js';

// Store interface
export type { IConversationStore } from './store-interface.js';

// Primary store
export { ConversationStore } from './store.js';

// Minimal store (fallback for CLI/tests)
export { MinimalStore } from './minimal-store.js';

// Store initialization
export {
    initializeStore,
    type StoreConfig,
    type StoreResult,
} from './init.js';

// Deduplication utilities
export {
    hashMessage,
    createFingerprint,
    fingerprintMessages,
    findNewMessages,
} from './deduplication.js';

// Key management
export {
    KeyManager,
    getKeyManager,
    resetKeyManager,
    type KeyManagerConfig,
} from './key-manager.js';

// Re-export LumoApi types for consumers
export { LumoApi } from '@lumo/remote/api.js';
export { RoleInt, StatusInt } from '@lumo/remote/types.js';

// ============================================================================
// Persistence initialization
// ============================================================================

import { logger } from '../app/logger.js';
import type { AuthProvider, ProtonApi } from '../auth/index.js';
import type { ConversationsConfig } from '../app/config.js';
import { getKeyManager } from './key-manager.js';
import { initializeStore, pullIncompleteConversations, type StoreResult } from './init.js';
import type { IConversationStore } from './store-interface.js';

// ============================================================================
// Conversation Store Initialization
// ============================================================================

export interface InitializeStoreOptions {
    protonApi: ProtonApi;
    uid: string;
    authProvider: AuthProvider;
    conversationsConfig: ConversationsConfig;
}

export interface InitializeStoreResult {
    /** Whether the primary store is being used (vs fallback) */
    isPrimary: boolean;
    /** Store result, only set when primary store is used */
    storeResult?: StoreResult;
}

// Module-level state to track store result for sync initialization
let primaryStoreResult: StoreResult | null = null;

// Singleton for the active store
let activeStore: IConversationStore | null = null;

/**
 * Initialize the conversation store
 *
 * Creates the primary ConversationStore (Redux + IndexedDB) if possible.
 * Returns undefined if initialization fails - callers should handle this
 * gracefully (server works stateless, CLI creates MinimalStore).
 *
 * Primary store requires:
 * - Auth provider supports persistence (has cached encryption keys)
 * - keyPassword is available (for master key decryption)
 */
export async function initializeConversationStore(
    options: InitializeStoreOptions
): Promise<InitializeStoreResult> {
    const { authProvider } = options;

    // Check if ConversationStore can be used
    const storeWarning = authProvider.getConversationStoreWarning();
    if (storeWarning) {
        logger.warn({ method: authProvider.method }, storeWarning);
        return { isPrimary: false };
    }

    // If we get here, getConversationStoreWarning() confirmed keyPassword exists
    const keyPassword = authProvider.getKeyPassword()!;

    // All conditions met - initialize primary store
    try {
        const result = await initializePrimaryStore(options, keyPassword);
        if (result) {
            activeStore = result.conversationStore;
            primaryStoreResult = result;
            logger.info('Using primary conversation store');

            // Pull incomplete conversations in background when sync is enabled
            if (options.conversationsConfig.enableSync) {
                pullIncompleteConversations(result.store, result.spaceId)
                    .catch(err => logger.error({ error: err }, 'Failed to pull incomplete conversations'));
            }

            return { isPrimary: true, storeResult: result };
        }
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error({ error: msg }, 'Failed to initialize primary store. Continuing without store.');
    }

    return { isPrimary: false };
}

/**
 * Initialize the primary conversation store
 */
async function initializePrimaryStore(
    options: InitializeStoreOptions,
    keyPassword: string
): Promise<StoreResult | null> {
    const { protonApi, uid, authProvider, conversationsConfig } = options;

    // Get cached keys from browser provider if available
    const cachedUserKeys = authProvider.getCachedUserKeys?.();
    const cachedMasterKeys = authProvider.getCachedMasterKeys?.();

    logger.info(
        {
            method: authProvider.method,
            hasCachedUserKeys: !!cachedUserKeys,
            hasCachedMasterKeys: !!cachedMasterKeys,
        },
        'Initializing KeyManager for primary store...'
    );

    // Initialize KeyManager
    const keyManager = getKeyManager({
        protonApi,
        cachedUserKeys,
        cachedMasterKeys,
    });
    await keyManager.initialize(keyPassword);

    // Get master key as base64 for crypto layer
    const masterKeyBase64 = keyManager.getMasterKeyBase64();

    const result = await initializeStore({
        sessionUid: uid,
        userId: authProvider.getUserId() ?? uid,
        masterKey: masterKeyBase64,
        projectName: conversationsConfig.projectName,
    });

    return result;
}

/**
 * Get the active conversation store
 *
 * Returns the initialized store, or undefined if no store is available.
 * Callers should handle undefined gracefully (stateless mode).
 */
export function getConversationStore(): IConversationStore | undefined {
    return activeStore ?? undefined;
}

/**
 * Set the active conversation store (for mock mode or CLI fallback)
 */
export function setConversationStore(store: IConversationStore): void {
    activeStore = store;
}

/**
 * Reset the conversation store (for testing)
 */
export function resetConversationStore(): void {
    activeStore = null;
    primaryStoreResult = null;
}

// ============================================================================
// Sync Initialization
// ============================================================================

export interface InitializeSyncOptions {
    protonApi: ProtonApi;
    uid: string;
    authProvider: AuthProvider;
    conversationsConfig: ConversationsConfig;
}

/**
 * Initialize sync services
 *
 * Sync is handled automatically by Redux sagas when primary store is active.
 * Returns false if no primary store or sync is disabled.
 */
export function initializeSync(options: InitializeSyncOptions): boolean {
    const { authProvider, conversationsConfig } = options;

    if (!conversationsConfig?.enableSync) {
        logger.info('Sync is disabled, skipping sync initialization');
        return false;
    }

    const syncWarning = authProvider.getSyncWarning();
    if (syncWarning) {
        logger.warn({ method: authProvider.method }, syncWarning);
        return false;
    }

    logger.info(
        { method: authProvider.method },
        'Sync initialized (handled by sagas)'
    );
    return true;
}
