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

export interface InitializeSyncOptions {
    protonApi: ProtonApi;
    uid: string;
    authProvider: AuthProvider;
    conversationsConfig: ConversationsConfig;
}

export interface InitializeSyncResult {
    initialized: boolean;
}

/**
 * Initialize sync services (KeyManager, SyncService, AutoSyncService)
 *
 * Handles all the setup for conversation sync including:
 * - Checking if sync is supported by the auth method
 * - Initializing KeyManager with encryption keys
 * - Setting up SyncService for conversation sync
 * - Configuring AutoSyncService if enabled
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
        logger.warn(
            { method: authProvider.method },
            'Persistence requires browser auth (SRP/rclone tokens lack lumo scope for spaces API)'
        );
        return { initialized: false };
    }

    const keyPassword = authProvider.getKeyPassword();
    if (!keyPassword) {
        logger.info(
            { method: authProvider.method },
            'No keyPassword available - sync will not be initialized'
        );
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
            },
            'Initializing KeyManager with keyPassword...'
        );

        // Initialize KeyManager
        const keyManager = getKeyManager({
            protonApi,
            cachedUserKeys,
            cachedMasterKeys,
        });

        await keyManager.initialize(keyPassword);

        // Initialize SyncService
        const syncService = getSyncService({
            protonApi,
            uid,
            keyManager,
            spaceName: syncConfig.spaceName,
            spaceId: syncConfig.spaceId,
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
                'getOrCreateSpace failed, but sync service is still available for commands'
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
