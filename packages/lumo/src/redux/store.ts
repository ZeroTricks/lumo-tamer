/**
 * Node.js-adapted Redux store for lumo-tamer
 *
 * Simplified version without browser-specific middleware and listeners.
 * Removes dependencies on @proton/account, @proton/redux-shared-store.
 */

import { type Middleware, configureStore } from '@reduxjs/toolkit';
import type { SagaMiddleware } from 'redux-saga';

import type { DbApi } from '../indexedDb/db';
import type { LumoApi } from '../remote/api';
import { rootReducer } from './rootReducer';

export const setupStore = ({
    preloadedState,
    sagaMiddleware,
}: {
    preloadedState?: Partial<LumoState>;
    sagaMiddleware: SagaMiddleware<LumoSagaContext>;
}) => {
    const store = configureStore({
        preloadedState,
        reducer: rootReducer,
        devTools: false,
        middleware: (getDefaultMiddleware) => {
            const m1 = getDefaultMiddleware({
                serializableCheck: false,
                immutableCheck: false,
                thunk: false,
            });
            const m2 = m1.concat(sagaMiddleware);
            return m2;
        },
    });

    return Object.assign(store, {
        unsubscribe: () => {
            // No listeners to clear in Node.js version
        },
    });
};

export type LumoState = ReturnType<typeof rootReducer>;
export type LumoStore = ReturnType<typeof setupStore>;
export type LumoDispatch = LumoStore['dispatch'];
export type LumoMiddleware = Middleware<{}, LumoState>;
export type LumoSagaContext = {
    dbApi: DbApi;
    lumoApi: LumoApi;
};
export type LumoSaga = LumoMiddleware & SagaMiddleware<LumoSagaContext>;
