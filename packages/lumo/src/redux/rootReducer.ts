/**
 * Node.js-adapted root reducer for lumo-tamer
 *
 * Removes dependency on @proton/redux-shared-store
 */

import { combineReducers } from '@reduxjs/toolkit';

import { lumoReducers } from './slices';

export const rootReducer = combineReducers({
    ...lumoReducers,
});
