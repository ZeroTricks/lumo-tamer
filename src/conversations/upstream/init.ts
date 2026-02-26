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
import type { ConversationStoreConfig, SpaceId } from '../types.js';

import { DbApi } from '@lumo/indexedDb/db.js';
import { generateSpaceKeyBase64 } from '@lumo/crypto/index.js';
import { addMasterKey } from '@lumo/redux/slices/core/credentials.js';
import {
    addSpace,
    pushSpaceRequest,
    pullSpacesSuccess,
    pullSpacesFailure,
} from '@lumo/redux/slices/core/spaces.js';
import { setupStore, type LumoSagaContext, type LumoStore } from '@lumo/redux/store.js';
import { LumoApi } from '@lumo/remote/api.js';
import type { Space } from '@lumo/types.js';

import { UpstreamConversationStore } from './adapter.js';

export interface UpstreamStoreConfig {
    /** Session UID for API authentication (x-pm-uid header) */
    sessionUid: string;
    /** Stable user ID for database naming (userKeys[0].ID) */
    userId: string;
    masterKey: string; // Base64-encoded master key
    spaceId: SpaceId;
    storeConfig: ConversationStoreConfig;
}

export interface UpstreamStoreResult {
    store: LumoStore;
    conversationStore: UpstreamConversationStore;
    dbApi: DbApi;
    spaceId: SpaceId;
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
    const { sessionUid, userId, masterKey, spaceId, storeConfig } = config;

    logger.info({ userId: userId.slice(0, 8) + '...' }, 'Initializing upstream storage');

    // 1. Import indexeddb polyfill (must happen before DbApi)
    // This is done at module level in the polyfill file
    await import('../../shims/indexeddb-polyfill.js');

    // 2. Create DbApi for IndexedDB operations (uses stable userId for db naming)
    const dbApi = new DbApi(userId);
    await dbApi.initialize();
    logger.debug('DbApi initialized');

    // 3. Create LumoApi for server communication (uses sessionUid for x-pm-uid header)
    // Note: fetch adapter is installed at Application level (app/index.ts)
    const lumoApi = new LumoApi(sessionUid);

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
    const { rootSaga } = await import('@lumo/redux/sagas/index.js');
    sagaMiddleware.run(rootSaga);
    logger.debug('Root saga started');

    // 7. Dispatch master key to Redux (triggers initAppSaga which loads from IDB)
    store.dispatch(addMasterKey(masterKey));

    // 8. Wait for Redux to load from IndexedDB
    // The initAppSaga (triggered by addMasterKey) handles loading from IDB
    await waitForReduxLoaded(store);

    // 9. Wait for remote spaces to be fetched (or fail/timeout)
    // This ensures we don't create a space locally if it already exists remotely
    await waitForRemoteSpaces(store);

    // 10. Ensure the space exists in Redux
    // If the space wasn't loaded from IDB or server, create it
    await ensureSpaceExists(store, spaceId);

    // 10. Create adapter
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
        spaceId,
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
 * Wait for remote spaces to be fetched (or fail/timeout)
 *
 * The initAppSaga triggers pullSpacesRequest after loading from IDB.
 * We need to wait for that to complete before checking if our space exists,
 * otherwise we might create a local space that conflicts with a remote one.
 * TODO: this looks like a good thing to have on a generic level
 */
async function waitForRemoteSpaces(
    store: LumoStore,
    timeoutMs: number = 15000
): Promise<void> {
    return new Promise((resolve) => {
        const start = Date.now();

        const unsubscribe = store.subscribe(() => {
            // Check timeout
            if (Date.now() - start > timeoutMs) {
                logger.warn('Timeout waiting for remote spaces fetch');
                unsubscribe();
                resolve();
                return;
            }
        });

        // Listen for pullSpacesSuccess or pullSpacesFailure actions
        // We use a middleware-like approach by checking action types
        const checkAction = (action: { type: string }) => {
            if (action.type === pullSpacesSuccess.type) {
                logger.debug('Remote spaces fetched successfully');
                unsubscribe();
                resolve();
                return true;
            }
            if (action.type === pullSpacesFailure.type) {
                logger.debug('Remote spaces fetch failed (sync may be disabled)');
                unsubscribe();
                resolve();
                return true;
            }
            return false;
        };

        // Wrap the store's dispatch to intercept actions
        const originalDispatch = store.dispatch;
        store.dispatch = ((action: { type: string }) => {
            checkAction(action);
            return originalDispatch(action);
        }) as typeof store.dispatch;

        // Restore original dispatch after timeout
        setTimeout(() => {
            store.dispatch = originalDispatch;
            unsubscribe();
            resolve();
        }, timeoutMs);
    });
}

/**
 * Ensure the space exists in Redux, creating if necessary
 */
async function ensureSpaceExists(store: LumoStore, spaceId: SpaceId): Promise<void> {
    const state = store.getState();

    if (state.spaces[spaceId]) {
        logger.debug({ spaceId }, 'Space already exists in Redux');
        return;
    }

    logger.info({ spaceId }, 'Creating new space for upstream storage');

    const now = new Date().toISOString();
    const spaceKey = generateSpaceKeyBase64();

    const newSpace: Space = {
        id: spaceId,
        createdAt: now,
        updatedAt: now,
        spaceKey,
        isProject: false,
    };

    store.dispatch(addSpace(newSpace));
    store.dispatch(pushSpaceRequest({ id: spaceId, priority: 'urgent' }));
}

/**
 * Cleanup upstream store resources
 */
export async function cleanupUpstreamStore(_result: UpstreamStoreResult): Promise<void> {
    // Fetch adapter cleanup is handled at Application level
    logger.debug('Upstream store cleaned up');
}
