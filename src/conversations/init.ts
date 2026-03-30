/**
 * Conversation Store Initialization
 *
 * Sets up the Redux store with saga middleware, IndexedDB persistence,
 * and returns a ConversationStore.
 *
 * This module handles:
 * 1. IndexedDB polyfill initialization (must happen first)
 * 2. DbApi creation for local persistence
 * 3. Redux store setup with saga middleware
 * 4. Root saga startup
 * 5. Waiting for IDB data to load into Redux
 */

import createSagaMiddleware from 'redux-saga';

import { logger } from '../app/logger.js';
import type { SpaceId } from './types.js';

import { DbApi } from '@lumo/indexedDb/db.js';
import { generateSpaceKeyBase64 } from '@lumo/crypto/index.js';
import { addMasterKey } from '@lumo/redux/slices/core/credentials.js';
import {
    addSpace,
    pushSpaceRequest,
    pullSpacesSuccess,
    pullSpacesFailure,
} from '@lumo/redux/slices/core/spaces.js';
import { pullConversationRequest } from '@lumo/redux/slices/core/conversations.js';
import {
    selectConversationsBySpaceId,
    selectMessagesByConversationId,
} from '@lumo/redux/selectors.js';
import { setupStore, type LumoSagaContext, type LumoStore } from '@lumo/redux/store.js';
import { LumoApi } from '@lumo/remote/api.js';
import type { Space } from '@lumo/types.js';

import { ConversationStore } from './store.js';

export interface StoreConfig {
    /** Session UID for API authentication (x-pm-uid header) */
    sessionUid: string;
    /** Stable user ID for database naming (userKeys[0].ID) */
    userId: string;
    masterKey: string; // Base64-encoded master key
    /** Project name for finding/creating the space */
    projectName: string;
}

export interface StoreResult {
    store: LumoStore;
    conversationStore: ConversationStore;
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
 * - ConversationStore adapter for compatibility
 *
 * Space resolution (after remote spaces are fetched):
 * 1. Find existing space by projectName in Redux state
 * 2. Create new space with projectName if no match
 */
export async function initializeStore(
    config: StoreConfig
): Promise<StoreResult> {
    const { sessionUid, userId, masterKey, projectName } = config;

    logger.info({ userId: userId.slice(0, 8) + '...' }, 'Initializing upstream storage');

    // 1. Import indexeddb polyfill (must happen before DbApi)
    // This is done at module level in the polyfill file
    await import('../shims/indexeddb-polyfill.js');

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

    // 10. Find or create space by projectName
    // Spaces are now decrypted in Redux state, so we can search directly
    const spaceId = findOrCreateSpace(store, projectName);

    // 11. Create adapter
    const conversationStore = new ConversationStore(store, spaceId);

    logger.info({ spaceId }, 'Upstream storage initialized successfully');

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
 * Find existing space by projectName or create a new one
 *
 * After waitForRemoteSpaces(), all spaces are decrypted in Redux state,
 * so we can search directly without manual decryption.
 */
function findOrCreateSpace(
    store: LumoStore,
    projectName: string
): SpaceId {
    const state = store.getState();
    const spaces = Object.values(state.spaces);

    logger.info({
        projectName,
        totalSpaces: spaces.length,
    }, 'Finding space by name...');

    // Search for existing space by projectName
    for (const space of spaces) {
        if (space.isProject && space.projectName === projectName) {
            logger.info({
                spaceId: space.id,
                projectName: space.projectName,
            }, 'Found existing project by name');
            return space.id;
        }
    }

    // Create new space with projectName
    const spaceId = crypto.randomUUID();
    logger.info({ spaceId, projectName }, 'Creating new project space');

    const now = new Date().toISOString();
    const spaceKey = generateSpaceKeyBase64();

    const newSpace: Space = {
        id: spaceId,
        createdAt: now,
        updatedAt: now,
        spaceKey,
        isProject: true,
        projectName,
    };

    store.dispatch(addSpace(newSpace));
    store.dispatch(pushSpaceRequest({ id: spaceId, priority: 'urgent' }));

    return spaceId;
}

/**
 * Pull conversations that have no messages loaded.
 *
 * After pullSpaces, conversations exist in Redux but may have no messages yet.
 * This dispatches pullConversationRequest for each empty conversation to fetch
 * full content from the server.
 *
 * Note: This does NOT handle messages that fail to decrypt (e.g., key mismatch
 * or corruption). Those remain in IDB but are skipped during loadReduxFromIdb.
 */
export async function pullIncompleteConversations(
    store: LumoStore,
    spaceId: SpaceId
): Promise<void> {
    const state = store.getState();

    // Get conversations for this space from Redux
    const conversations = selectConversationsBySpaceId(spaceId)(state);

    // Find conversations with no messages in Redux
    const emptyConversationIds = Object.values(conversations)
        .filter(c => Object.keys(selectMessagesByConversationId(c.id)(state)).length === 0)
        .map(c => c.id);

    if (emptyConversationIds.length === 0) {
        return;
    }

    logger.info({ count: emptyConversationIds.length }, 'Pulling incomplete conversations');

    // Dispatch pulls with rate limiting to avoid request bursts
    for (const id of emptyConversationIds) {
        store.dispatch(pullConversationRequest({ id }));
        await new Promise(resolve => setTimeout(resolve, 100));
    }
}
