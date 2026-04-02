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
} from './types.js';

// Store
export { ConversationStore } from './store.js';

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
import { ConversationStore } from './store.js';

// ============================================================================
// Conversation Store Initialization
// ============================================================================

export interface InitializeStoreOptions {
    protonApi: ProtonApi;
    uid: string;
    authProvider: AuthProvider;
    conversationsConfig: ConversationsConfig;
}

// Module-level state to track store result for sync initialization
let storeResult: StoreResult | null = null;

// Singleton for the active store
let activeStore: ConversationStore | null = null;

/**
 * Initialize the conversation store
 *
 * Creates the ConversationStore (Redux + IndexedDB) if possible.
 * Logs warnings if initialization fails - callers should handle this
 * gracefully (server works stateless, CLI uses local Turn array).
 *
 * Requires:
 * - Auth provider supports persistence (has cached encryption keys)
 * - keyPassword is available (for master key decryption)
 */
export async function initializeConversationStore(
    options: InitializeStoreOptions
): Promise<void> {
    const { authProvider, conversationsConfig } = options;

    // Check if store is disabled via config
    if (!conversationsConfig.enableStore) {
        logger.info('ConversationStore disabled via config');
        return;
    }

    // Check if ConversationStore can be used
    const storeWarning = authProvider.getConversationStoreWarning();
    if (storeWarning) {
        logger.warn({ method: authProvider.method }, storeWarning);
        return;
    }

    // If we get here, getConversationStoreWarning() confirmed keyPassword exists
    const keyPassword = authProvider.getKeyPassword()!;

    // Get cached keys from browser provider if available
    const cachedUserKeys = authProvider.getCachedUserKeys?.();
    const cachedMasterKeys = authProvider.getCachedMasterKeys?.();

    logger.info(
        {
            method: authProvider.method,
            hasCachedUserKeys: !!cachedUserKeys,
            hasCachedMasterKeys: !!cachedMasterKeys,
        },
        'Initializing KeyManager...'
    );

    // Initialize KeyManager
    const keyManager = getKeyManager({
        protonApi: options.protonApi,
        cachedUserKeys,
        cachedMasterKeys,
    });

    try {
        await keyManager.initialize(keyPassword);

        // Get master key as base64 for crypto layer
        const masterKeyBase64 = keyManager.getMasterKeyBase64();

        const result = await initializeStore({
            sessionUid: options.uid,
            userId: authProvider.getUserId() ?? options.uid,
            masterKey: masterKeyBase64,
            projectName: conversationsConfig.projectName,
        });

        activeStore = result.conversationStore;
        storeResult = result;
        logger.info('ConversationStore initialized');

        // Pull incomplete conversations in background when sync is enabled
        if (conversationsConfig.enableSync) {
            pullIncompleteConversations(result.store, result.spaceId)
                .catch(err => logger.error({ error: err }, 'Failed to pull incomplete conversations'));
        }
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error({ error: msg }, 'Failed to initialize store. Continuing without store.');
    }
}

/**
 * Get the active conversation store
 *
 * Returns the initialized store, or undefined if no store is available.
 * Callers should handle undefined gracefully (stateless mode).
 */
export function getConversationStore(): ConversationStore | undefined {
    return activeStore ?? undefined;
}

/**
 * Set the active conversation store (for mock mode or CLI fallback)
 */
export function setConversationStore(store: ConversationStore): void {
    activeStore = store;
}

/**
 * Reset the conversation store (for testing)
 */
export function resetConversationStore(): void {
    activeStore = null;
    storeResult = null;
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
 * Sync is handled automatically by Redux sagas when the store is active.
 * Returns false if no store or sync is disabled.
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
