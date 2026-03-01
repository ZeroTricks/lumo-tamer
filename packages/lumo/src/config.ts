/**
 * Config Shim for upstream Proton code
 *
 * Replaces: applications/lumo/src/app/config.ts
 *
 * Values here should match upstream WebClients.
 * sync-upstream.sh will warn if APP_VERSION changes.
 */

export const APP_NAME = 'proton-lumo' as const;
export const APP_VERSION = '5.0.0';
export const API_URL = '/api';

// app version we need to use in our api calls (x-pm-appversion header)
export const APP_VERSION_HEADER = `web-lumo@${APP_VERSION}`;

export default { APP_NAME, APP_VERSION, API_URL };
