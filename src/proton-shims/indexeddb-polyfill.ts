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

import { getConversationsConfig } from '../app/config.js';
import { resolveProjectPath } from '../app/paths.js';

// Initialize indexeddbshim with Node.js-compatible settings
// checkOrigin: false - required for Node.js (no window.location)
// databaseBasePath - where SQLite files are stored (resolved to absolute path)
const config = getConversationsConfig();
indexeddbshim(globalThis as Parameters<typeof indexeddbshim>[0], {
    checkOrigin: false,
    databaseBasePath: resolveProjectPath(config.databasePath),
});

// Re-export for explicit use if needed
export { indexeddbshim };
