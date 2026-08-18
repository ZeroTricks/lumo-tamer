/**
 * IndexedDB Polyfill for Node.js
 *
 * Uses indexeddbshim to provide SQLite-backed IndexedDB API.
 * This allows pulling upstream db.ts unchanged.
 *
 * IMPORTANT: This file must be imported BEFORE any code that uses IndexedDB.
 *
 * Source: https://www.npmjs.com/package/indexeddbshim
 */

import indexeddbshim from 'indexeddbshim';

import { ensureHome, getConversationsDbPath } from '../app/paths.js';

// Ensure home directory exists (creates with 0o700 if missing)
ensureHome();

// databaseBasePath - where SQLite files are stored
const databaseBasePath = getConversationsDbPath();


// Initialize indexeddbshim with Node.js-compatible settings
// checkOrigin: false - required for Node.js (no window.location)
indexeddbshim(globalThis as Parameters<typeof indexeddbshim>[0], {
    checkOrigin: false,
    databaseBasePath,
    escapeDatabaseName: (dbName: string) => {
        // Produce readable filenames instead of default ^-escapes
        // Lowercase is safe, Lumo db names are `${DB_BASE_NAME}_${userHash}`
        // See packages/lumo/src/indexedDb/db.ts#L1170
        // Replace base64 URL-unsafe chars: + -> -, / -> _, = -> (remove)
return (
            dbName
                .toLowerCase()
                .replace(/\+/g, '-')
                .replace(/\//g, '_')
                .replace(/=/g, '')
                .substring(0, 24)
                 + '.sqlite'
        );
    },
});

// Re-export for explicit use if needed
export { indexeddbshim };
