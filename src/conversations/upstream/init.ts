/**
 * Upstream Store Initialization
 *
 * Sets up the Redux store with saga middleware, IndexedDB persistence,
 * and returns an UpstreamConversationStore adapter.
 *
 * This module handles:
 * 1. IndexedDB polyfill initialization (must happen first)
 * 2. DbApi creation for local persistence
 * 3. Redux store setup with saga middleware
 * 4. Root saga startup
 * 5. Waiting for IDB data to load into Redux
 */

import createSagaMiddleware from 'redux-saga';

import { logger } from '../../app/logger.js';
import type { ProtonApi } from '../../lumo-client/types.js';
import type { ConversationStoreConfig, SpaceId } from '../types.js';

import { setupStore, type LumoStore, type LumoSagaContext } from '../../proton-upstream/redux/store.js';
import { DbApi } from '../../proton-upstream/indexedDb/db.js';
import { LumoApi } from '../../proton-upstream/remote/api.js';
import { addMasterKey } from '../../proton-upstream/redux/slices/core/credentials.js';

import { installFetchAdapter } from '../../proton-shims/fetch-adapter.js';
import { UpstreamConversationStore } from './adapter.js';

export interface UpstreamStoreConfig {
    uid: string;
    protonApi: ProtonApi;
    masterKey: string; // Base64-encoded master key
    spaceId: SpaceId;
    storeConfig: ConversationStoreConfig;
}

export interface UpstreamStoreResult {
    store: LumoStore;
    conversationStore: UpstreamConversationStore;
    dbApi: DbApi;
    cleanup: () => void;
}

/**
 * Initialize the upstream storage system
 *
 * This sets up:
 * - IndexedDB (via indexeddbshim) for local persistence
 * - Redux store for in-memory state
 * - Saga middleware for async operations
 * - UpstreamConversationStore adapter for compatibility
 */
export async function initializeUpstreamStore(
    config: UpstreamStoreConfig
): Promise<UpstreamStoreResult> {
    const { uid, protonApi, masterKey, spaceId, storeConfig } = config;

    logger.info({ uid: uid.slice(0, 8) + '...' }, 'Initializing upstream storage');

    // 1. Import indexeddb polyfill (must happen before DbApi)
    // This is done at module level in the polyfill file
    await import('../../proton-upstream/indexeddb-polyfill.js');

    // 2. Create DbApi for IndexedDB operations
    const dbApi = new DbApi(uid);
    await dbApi.initialize();
    logger.debug('DbApi initialized');

    // 3. Install fetch adapter and create LumoApi for server communication
    // The fetch adapter intercepts /api/ calls and routes through ProtonApi
    const cleanupFetch = installFetchAdapter(protonApi);
    const lumoApi = new LumoApi(uid);

    // 4. Create saga middleware with context
    const sagaContext: LumoSagaContext = {
        dbApi,
        lumoApi,
    };

    const sagaMiddleware = createSagaMiddleware({
        context: sagaContext,
    });

    // 5. Setup Redux store
    const store = setupStore({
        sagaMiddleware,
    });

    logger.debug('Redux store created');

    // 6. Start root saga (essential for sync functionality)
    const { rootSaga } = await import('../../proton-upstream/redux/sagas/index.js');
    sagaMiddleware.run(rootSaga);
    logger.debug('Root saga started');

    // 7. Dispatch master key to Redux (triggers initAppSaga which loads from IDB)
    store.dispatch(addMasterKey(masterKey));

    // 8. Wait for Redux to load from IndexedDB
    // The initAppSaga (triggered by addMasterKey) handles loading from IDB
    await waitForReduxLoaded(store);

    // 9. Create adapter
    const conversationStore = new UpstreamConversationStore(
        store,
        spaceId,
        storeConfig
    );

    logger.info('Upstream storage initialized successfully');

    return {
        store,
        conversationStore,
        dbApi,
        cleanup: cleanupFetch,
    };
}

/**
 * Wait for Redux state to be loaded from IndexedDB
 */
async function waitForReduxLoaded(
    store: LumoStore,
    timeoutMs: number = 10000
): Promise<void> {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
        const state = store.getState();
        if (state.initialization?.reduxLoadedFromIdb) {
            logger.debug('Redux loaded from IDB via saga');
            return;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }

    logger.warn('Timeout waiting for Redux to load from IDB');
}

/**
 * Cleanup upstream store resources
 */
export async function cleanupUpstreamStore(result: UpstreamStoreResult): Promise<void> {
    // Restore original fetch
    result.cleanup();
    logger.debug('Upstream store cleaned up');
}
