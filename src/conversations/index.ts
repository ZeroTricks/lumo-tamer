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
    ConversationStoreConfig,
    SpaceId,
    RemoteId,
    IdMapEntry,
} from './types.js';

// Store
export {
    ConversationStore,
    getConversationStore,
    resetConversationStore,
} from './store.js';

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

// Encryption / Key management
export {
    KeyManager,
    getKeyManager,
    resetKeyManager,
    type KeyManagerConfig,
} from './encryption/index.js';

// Sync service
export {
    SyncService,
    getSyncService,
    resetSyncService,
    type SyncServiceConfig,
} from './sync/index.js';

// Auto-sync service
export {
    AutoSyncService,
    getAutoSyncService,
    resetAutoSyncService,
} from './sync/index.js';

// Re-export LumoApi types for consumers
export {
    LumoApi,
    createLumoApi,
    cleanupLumoApi,
    RoleInt,
    StatusInt,
} from './sync/lumo-api.js';

// ============================================================================
// Persistence initialization
// ============================================================================

import { logger } from '../app/logger.js';
import type { AuthProvider, ProtonApi } from '../auth/index.js';
import type { ConversationsConfig } from '../app/config.js';
import { getKeyManager } from './encryption/index.js';
import { getSyncService, getAutoSyncService } from './sync/index.js';
import { getConversationStore } from './store.js';

// Upstream storage imports (dynamic import to avoid loading when not needed)
import type { UpstreamStoreResult } from './upstream/index.js';

export interface InitializeSyncOptions {
    protonApi: ProtonApi;
    uid: string;
    authProvider: AuthProvider;
    conversationsConfig: ConversationsConfig;
}

export interface InitializeSyncResult {
    initialized: boolean;
    /** Upstream store result, only set when useUpstreamStorage is enabled */
    upstreamStore?: UpstreamStoreResult;
}

/**
 * Initialize sync services (KeyManager, SyncService, AutoSyncService)
 *
 * Handles all the setup for conversation sync including:
 * - Checking if sync is supported by the auth method
 * - Initializing KeyManager with encryption keys
 * - Setting up SyncService for conversation sync
 * - Configuring AutoSyncService if enabled
 *
 * When useUpstreamStorage is enabled, uses the upstream Redux + IndexedDB
 * storage layer instead of the lumo-tamer implementation.
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

    if (!authProvider.supportsPersistence()) {
        if (conversationsConfig.useUpstreamStorage) {
            logger.warn(
                { method: authProvider.method },
                'Upstream storage requires browser auth (for master key decryption). ' +
                'Falling back to in-memory storage only.'
            );
        } else {
            logger.warn(
                { method: authProvider.method },
                'Conversation sync requires browser auth method'
            );
        }
        return { initialized: false };
    }

    const keyPassword = authProvider.getKeyPassword();
    if (!keyPassword) {
        if (conversationsConfig.useUpstreamStorage) {
            logger.warn(
                { method: authProvider.method },
                'Upstream storage requires keyPassword (for master key decryption). ' +
                'Falling back to in-memory storage only.'
            );
        } else {
            logger.info(
                { method: authProvider.method },
                'No keyPassword available - sync will not be initialized'
            );
        }
        return { initialized: false };
    }

    try {
        // Get cached keys from browser provider if available
        const cachedUserKeys = authProvider.getCachedUserKeys?.();
        const cachedMasterKeys = authProvider.getCachedMasterKeys?.();

        logger.info(
            {
                method: authProvider.method,
                hasCachedUserKeys: !!cachedUserKeys,
                hasCachedMasterKeys: !!cachedMasterKeys,
                useUpstreamStorage: conversationsConfig.useUpstreamStorage,
            },
            'Initializing KeyManager with keyPassword...'
        );

        // Initialize KeyManager (needed for both modes)
        const keyManager = getKeyManager({
            protonApi,
            cachedUserKeys,
            cachedMasterKeys,
        });

        await keyManager.initialize(keyPassword);

        // Branch: use upstream storage or lumo-tamer storage
        if (conversationsConfig.useUpstreamStorage) {
            return initializeUpstreamSync(options, keyManager);
        }

        // Standard lumo-tamer sync initialization
        const syncService = getSyncService({
            protonApi,
            uid,
            keyManager,
            spaceName: syncConfig.projectName,
            spaceId: syncConfig.projectId,
            includeSystemMessages: syncConfig.includeSystemMessages,
        });

        // Eagerly fetch/create space
        try {
            await syncService.getOrCreateSpace();
            logger.info({ method: authProvider.method }, 'Sync service initialized successfully');
        } catch (spaceError) {
            const msg = spaceError instanceof Error ? spaceError.message : String(spaceError);
            logger.warn(
                { error: msg },
                'getOrCreateSpace failed'
            );
        }

        // Initialize auto-sync if enabled
        if (syncConfig.autoSync) {
            const autoSync = getAutoSyncService(syncService, true);

            // Connect to conversation store
            const store = getConversationStore();
            store.setOnDirtyCallback(() => autoSync.notifyDirty());

            logger.info('Auto-sync enabled and connected to conversation store');
        }

        return { initialized: true };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const errorStack = error instanceof Error ? error.stack : undefined;
        logger.error({ errorMessage, errorStack }, 'Failed to initialize sync service');
        return { initialized: false };
    }
}

/**
 * Initialize upstream storage mode
 *
 * Uses the upstream WebClient storage layer (Redux + IndexedDB + Sagas)
 * instead of the lumo-tamer implementation.
 * TODO: move up
 */
async function initializeUpstreamSync(
    options: InitializeSyncOptions,
    keyManager: import('./encryption/index.js').KeyManager
): Promise<InitializeSyncResult> {
    const { protonApi, uid, authProvider, conversationsConfig } = options;
    const syncConfig = conversationsConfig.sync;

    logger.info('Initializing upstream storage mode');

    try {
        // Dynamic import to avoid loading upstream modules when not needed
        const { initializeUpstreamStore, UpstreamSyncService } = await import('./upstream/index.js');

        // Get master key as base64 for upstream crypto layer
        const masterKeyBase64 = keyManager.getMasterKeyBase64();

        // Generate or use configured space ID
        const spaceId = syncConfig.projectId ?? crypto.randomUUID();

        // Initialize upstream store
        const upstreamResult = await initializeUpstreamStore({
            uid,
            protonApi,
            masterKey: masterKeyBase64,
            spaceId,
            storeConfig: {
                maxConversationsInMemory: conversationsConfig.maxInMemory,
            },
        });

        // Create upstream sync service adapter
        const upstreamSyncService = new UpstreamSyncService({
            store: upstreamResult.store,
            dbApi: upstreamResult.dbApi,
            spaceId,
        });

        // Fetch/create space via upstream sagas
        try {
            await upstreamSyncService.getOrCreateSpace();
            logger.info({ method: authProvider.method }, 'Upstream sync service initialized');
        } catch (spaceError) {
            const msg = spaceError instanceof Error ? spaceError.message : String(spaceError);
            logger.warn({ error: msg }, 'Upstream getOrCreateSpace failed');
        }

        // Auto-sync is handled by sagas in upstream mode
        if (syncConfig.autoSync) {
            logger.info('Auto-sync enabled (handled by upstream sagas)');
        }

        return {
            initialized: true,
            upstreamStore: upstreamResult,
        };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const errorStack = error instanceof Error ? error.stack : undefined;
        logger.error({ errorMessage, errorStack }, 'Failed to initialize upstream storage');
        return { initialized: false };
    }
}
