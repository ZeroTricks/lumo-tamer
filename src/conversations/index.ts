/**
 * Conversation persistence module
 *
 * Provides:
 * - ConversationStore: Primary storage using Redux + IndexedDB
 * - FallbackStore: Legacy in-memory storage (deprecated)
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
    MessagePrivate,
    ConversationStoreConfig,
    SpaceId,
    RemoteId,
    IdMapEntry,
    MessageForStore,
} from './types.js';

// Primary store
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
    isValidContinuation,
    detectBranching,
} from './deduplication.js';

// Key management
export {
    KeyManager,
    getKeyManager,
    resetKeyManager,
    type KeyManagerConfig,
} from './key-manager.js';

// Fallback store and its sync (deprecated)
export {
    FallbackStore,
    getFallbackStore,
    resetFallbackStore,
} from './fallback/index.js';

export {
    SyncService,
    getSyncService,
    resetSyncService,
    type SyncServiceConfig,
    AutoSyncService,
    getAutoSyncService,
    resetAutoSyncService,
} from './fallback/index.js';

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
import { getSyncService, getAutoSyncService, getFallbackStore } from './fallback/index.js';
import { ConversationStore } from './store.js';
import { initializeStore, type StoreResult } from './init.js';
import type { ConversationStoreConfig } from './types.js';

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

// Singleton for the active store (either ConversationStore or FallbackStore)
let activeStore: ConversationStore | ReturnType<typeof getFallbackStore> | null = null;

/**
 * Initialize the conversation store
 *
 * Creates either the primary ConversationStore (Redux + IndexedDB) or
 * the fallback in-memory FallbackStore.
 *
 * Primary store is used when:
 * - useFallbackStore config is false (default)
 * - Auth provider supports persistence (browser auth)
 * - keyPassword is available (for master key decryption)
 */
export async function initializeConversationStore(
    options: InitializeStoreOptions
): Promise<InitializeStoreResult> {
    const { protonApi, uid, authProvider, conversationsConfig } = options;
    const storeConfig: ConversationStoreConfig = {
        maxConversationsInMemory: conversationsConfig.maxInMemory,
    };

    // Check if fallback is explicitly requested
    if (conversationsConfig.useFallbackStore) {
        logger.info('Using fallback store (explicitly configured)');
        activeStore = getFallbackStore(storeConfig);
        return { isPrimary: false };
    }

    // Try to initialize primary store
    if (!authProvider.supportsPersistence()) {
        logger.warn(
            { method: authProvider.method },
            'Primary store requires cached encryption keys. Falling back to in-memory store.'
        );
        activeStore = getFallbackStore(storeConfig);
        return { isPrimary: false };
    }

    const keyPassword = authProvider.getKeyPassword();
    if (!keyPassword) {
        logger.warn(
            { method: authProvider.method },
            'Primary store requires keyPassword. Falling back to in-memory store.'
        );
        activeStore = getFallbackStore(storeConfig);
        return { isPrimary: false };
    }

    // All conditions met - initialize primary store
    try {
        const result = await initializePrimaryStore(options, keyPassword);
        if (result) {
            activeStore = result.conversationStore;
            primaryStoreResult = result;
            logger.info('Using primary conversation store');
            return { isPrimary: true, storeResult: result };
        }
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error({ error: msg }, 'Failed to initialize primary store. Falling back to in-memory store.');
    }

    // Fallback
    activeStore = getFallbackStore(storeConfig);
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
    const syncConfig = conversationsConfig.sync;

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

    // Generate or use configured space ID
    const spaceId = syncConfig.projectId ?? crypto.randomUUID();

    // Initialize store
    const result = await initializeStore({
        sessionUid: uid,
        userId: authProvider.getUserId() ?? uid,
        masterKey: masterKeyBase64,
        spaceId,
        storeConfig: {
            maxConversationsInMemory: conversationsConfig.maxInMemory,
        },
    });

    return result;
}

/**
 * Get the active conversation store
 *
 * Returns whichever store was initialized (primary or fallback).
 * Throws if no store has been initialized.
 */
export function getConversationStore(): ConversationStore | ReturnType<typeof getFallbackStore> {
    if (!activeStore) {
        throw new Error('ConversationStore not initialized - call initializeConversationStore() first');
    }
    return activeStore;
}

/**
 * Set the active conversation store (for mock mode)
 */
export function setConversationStore(store: ConversationStore | ReturnType<typeof getFallbackStore>): void {
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

export interface InitializeSyncResult {
    initialized: boolean;
    /** Store result, only set when primary store is used */
    storeResult?: StoreResult;
}

/**
 * Initialize sync services
 *
 * For primary store: sync is handled automatically by Redux sagas.
 * For fallback store: sets up SyncService and AutoSyncService.
 */
export async function initializeSync(
    options: InitializeSyncOptions
): Promise<InitializeSyncResult> {
    const { protonApi, uid, authProvider, conversationsConfig } = options;
    const syncConfig = conversationsConfig?.sync;

    if (!syncConfig?.enabled) {
        logger.info('Sync is disabled, skipping sync initialization');
        return { initialized: false };
    }

    // Sync requires browser auth for lumo scope (spaces API access)
    if (!authProvider.supportsSync()) {
        logger.warn(
            { method: authProvider.method },
            'Conversation sync requires browser auth method'
        );
        return { initialized: false };
    }

    const keyPassword = authProvider.getKeyPassword();
    if (!keyPassword) {
        logger.warn(
            { method: authProvider.method },
            'No keyPassword available - sync will not be initialized'
        );
        return { initialized: false };
    }

    try {
        // Primary store: sync is handled by sagas
        if (primaryStoreResult) {
            logger.info(
                { method: authProvider.method, autoSync: syncConfig.autoSync },
                'Sync initialized (handled by sagas)'
            );
            return {
                initialized: true,
                storeResult: primaryStoreResult,
            };
        }

        // Fallback store: use SyncService + AutoSyncService
        const cachedUserKeys = authProvider.getCachedUserKeys?.();
        const cachedMasterKeys = authProvider.getCachedMasterKeys?.();

        logger.info(
            {
                method: authProvider.method,
                hasCachedUserKeys: !!cachedUserKeys,
                hasCachedMasterKeys: !!cachedMasterKeys,
            },
            'Initializing KeyManager for fallback sync...'
        );

        // Initialize KeyManager (needed for fallback sync)
        const keyManager = getKeyManager({
            protonApi,
            cachedUserKeys,
            cachedMasterKeys,
        });

        await keyManager.initialize(keyPassword);

        // Initialize SyncService
        const syncService = getSyncService({
            uid,
            keyManager,
            spaceName: syncConfig.projectName,
            spaceId: syncConfig.projectId,
            includeSystemMessages: syncConfig.includeSystemMessages,
        });

        // Eagerly fetch/create space
        try {
            await syncService.getOrCreateSpace();
            logger.info({ method: authProvider.method }, 'Fallback sync service initialized');
        } catch (spaceError) {
            const msg = spaceError instanceof Error ? spaceError.message : String(spaceError);
            logger.warn({ error: msg }, 'getOrCreateSpace failed');
        }

        // Initialize auto-sync if enabled
        if (syncConfig.autoSync) {
            const autoSync = getAutoSyncService(syncService, true);

            // Connect to fallback store
            const store = getFallbackStore();
            store.setOnDirtyCallback(() => autoSync.notifyDirty());

            logger.info('Auto-sync enabled for fallback store');
        }

        return { initialized: true };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const errorStack = error instanceof Error ? error.stack : undefined;
        logger.error({ errorMessage, errorStack }, 'Failed to initialize sync service');
        return { initialized: false };
    }
}
