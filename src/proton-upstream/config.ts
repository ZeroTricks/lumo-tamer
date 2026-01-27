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

// Convenience export for x-pm-appversion header
export const APP_VERSION_HEADER = `${APP_NAME}@${APP_VERSION}`;

export default { APP_NAME, APP_VERSION, API_URL };
