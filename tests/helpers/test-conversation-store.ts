/**
 * Test helper for ConversationStore (Redux + IndexedDB)
 *
 * Uses fake-indexeddb for in-memory IndexedDB implementation.
 * IMPORTANT: fake-indexeddb/auto must be imported BEFORE any code that uses IndexedDB.
 */

// Setup fake-indexeddb globals BEFORE any other imports
import 'fake-indexeddb/auto';

import createSagaMiddleware from 'redux-saga';

import { DbApi } from '@lumo/indexedDb/db.js';
import { LumoApi } from '@lumo/remote/api.js';
import { setupStore, type LumoStore } from '@lumo/redux/store.js';
import { rootSaga } from '@lumo/redux/sagas/index.js';
import { addMasterKey } from '@lumo/redux/slices/core/credentials.js';
import { ConversationStore } from '../../src/conversations/store.js';

export interface TestStoreContext {
    store: LumoStore;
    conversationStore: ConversationStore;
    dbApi: DbApi;
    cleanup: () => Promise<void>;
}

/**
 * Create a test ConversationStore with fake-indexeddb backend.
 *
 * Each call creates a unique IDB database for test isolation.
 */
export async function createTestConversationStore(): Promise<TestStoreContext> {
    const testUserId = 'test-user-' + Date.now() + '-' + Math.random().toString(36).slice(2);
    const testSpaceId = 'test-space-id';

    // Create DbApi (uses fake-indexeddb via globals)
    const dbApi = new DbApi(testUserId);
    await dbApi.initialize();

    // Create LumoApi (won't make real API calls - sagas handle errors gracefully)
    const lumoApi = new LumoApi('test-session-uid');

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
    const testMasterKey = Buffer.from('test-master-key-32bytes!12345678').toString('base64');
    store.dispatch(addMasterKey(testMasterKey));

    // Wait for Redux to load from IDB
    await waitForReduxLoaded(store);

    // Create ConversationStore adapter
    const conversationStore = new ConversationStore(
        store,
        testSpaceId,
        { maxConversationsInMemory: 50 }
    );

    // Cleanup function to cancel sagas
    const cleanup = async () => {
        sagaTask.cancel();
        await sagaTask.toPromise().catch(() => {});
    };

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
            return;
        }
        await new Promise(r => setTimeout(r, 50));
    }
    // Proceed anyway - fresh IDB has no data to load
}
