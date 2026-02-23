/**
 * Lumo user settings stub for Node.js
 *
 * The browser version stores user preferences.
 * For lumo-tamer, we stub this.
 */

import { createReducer } from '@reduxjs/toolkit';

export type LumoUserSettings = {
    enableSafeResponse?: boolean;
};

const initialState: LumoUserSettings = {
    enableSafeResponse: undefined,
};

const lumoUserSettingsReducer = createReducer(initialState, (builder) => {
    // No actions needed for Node.js stub
    builder;
});

export default lumoUserSettingsReducer;

// Selector stub
export const selectEnableSafeResponse = (_state: unknown): boolean | undefined => undefined;
