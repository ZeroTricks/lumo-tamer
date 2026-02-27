/**
 * Mock Store Initialization
 *
 * Initializes ConversationStore with fake-indexeddb for:
 * - Mock mode (manual testing without auth)
 * - Unit tests (automated testing)
 *
 * IMPORTANT: This module imports fake-indexeddb/auto which polyfills
 * IndexedDB globals. It must be imported BEFORE any code that uses IndexedDB.
 */

// Polyfill IndexedDB globals BEFORE any other imports
import 'fake-indexeddb/auto';

import createSagaMiddleware from 'redux-saga';

import { logger } from '../app/logger.js';
import { ConversationStore } from '../conversations/store.js';

import { DbApi } from '@lumo/indexedDb/db.js';
import { LumoApi } from '@lumo/remote/api.js';
import { generateSpaceKeyBase64 } from '@lumo/crypto/index.js';
import { setupStore, type LumoStore } from '@lumo/redux/store.js';
import { rootSaga } from '@lumo/redux/sagas/index.js';
import { addMasterKey } from '@lumo/redux/slices/core/credentials.js';
import { addSpace } from '@lumo/redux/slices/core/spaces.js';
import type { Space } from '@lumo/types.js';

export interface MockStoreOptions {
    /** Max conversations in memory (default: 50) */
    maxInMemory?: number;
    /** Unique user ID for IDB database naming (default: mock-user-{timestamp}) */
    userId?: string;
    /** Space ID for conversations (default: mock-space-id) */
    spaceId?: string;
}

export interface MockStoreResult {
    store: LumoStore;
    conversationStore: ConversationStore;
    dbApi: DbApi;
    cleanup: () => Promise<void>;
}

/**
 * Initialize ConversationStore with fake-indexeddb.
 *
 * Creates a fully functional Redux + IndexedDB store without
 * requiring authentication. Sagas run but API calls fail gracefully.
 */
export async function initializeMockStore(
    options: MockStoreOptions = {}
): Promise<MockStoreResult> {
    const {
        maxInMemory = 50,
        userId = 'mock-user-' + Date.now(),
        spaceId = 'mock-space-id',
    } = options;

    logger.debug({ userId, spaceId }, 'Initializing mock store with fake-indexeddb');

    // Create DbApi (uses fake-indexeddb via globals)
    const dbApi = new DbApi(userId);
    await dbApi.initialize();

    // Create LumoApi (won't make real API calls - sagas handle errors gracefully)
    const lumoApi = new LumoApi('mock-session-uid');

    // Setup saga middleware with context
    const sagaMiddleware = createSagaMiddleware({
        context: { dbApi, lumoApi },
    });

    // Create Redux store
    const store = setupStore({ sagaMiddleware });

    // Start sagas
    const sagaTask = sagaMiddleware.run(rootSaga);

    // Add master key (triggers initAppSaga which loads from IDB)
    // Use a valid 32-byte key for AES-256
    const mockMasterKey = Buffer.from('mock-master-key-32bytes!12345678').toString('base64');
    store.dispatch(addMasterKey(mockMasterKey));

    // Wait for Redux to load from IDB
    await waitForReduxLoaded(store);

    // Create space with spaceKey (enables encryption in sagas)
    const now = new Date().toISOString();
    const mockSpace: Space = {
        id: spaceId,
        createdAt: now,
        updatedAt: now,
        spaceKey: generateSpaceKeyBase64(),
        isProject: false,
    };
    store.dispatch(addSpace(mockSpace));

    // Create ConversationStore adapter
    const conversationStore = new ConversationStore(
        store,
        spaceId,
        { maxConversationsInMemory: maxInMemory }
    );

    // Cleanup function to cancel sagas
    const cleanup = async () => {
        sagaTask.cancel();
        await sagaTask.toPromise().catch(() => {});
    };

    logger.info({ userId: userId.slice(0, 20) + '...', spaceId }, 'Mock store initialized');

    return { store, conversationStore, dbApi, cleanup };
}

/**
 * Wait for Redux state to be loaded from IndexedDB.
 * For a fresh IDB, this will timeout and proceed (expected behavior).
 */
async function waitForReduxLoaded(store: LumoStore, timeoutMs = 3000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const state = store.getState();
        if (state.initialization?.reduxLoadedFromIdb) {
            logger.debug('Redux loaded from IDB');
            return;
        }
        await new Promise(r => setTimeout(r, 50));
    }
    // Proceed anyway - fresh IDB has no data to load
    logger.debug('Redux IDB load timeout (fresh database)');
}
