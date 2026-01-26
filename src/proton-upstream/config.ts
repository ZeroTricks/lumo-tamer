/**
 * Config Shim
 *
 * Replaces: applications/lumo/src/app/config.ts
 *
 * Original uses getProtonConfig() wrapper from @proton/shared.
 * This shim directly exports the values needed by remote/api.ts.
 *
 * Exports:
 * - APP_NAME: 'proton-lumo' - original line 5
 * - API_URL: '/api' - original line 6
 * - APP_VERSION: '5.0.0' - added by shim (not in original)
 */


// TODO: should we fetch these from somewhere else?
// ie. version is also in config file
export default {
    APP_NAME: 'proton-lumo' as const,
    APP_VERSION: '5.0.0',
    API_URL: '/api',
};
