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

import fs from 'fs';
import indexeddbshim from 'indexeddbshim';

import { getConversationsConfig } from '../app/config.js';
import { resolveProjectPath } from '../app/paths.js';


const config = getConversationsConfig();

// databaseBasePath - where SQLite files are stored (resolved to absolute path)
const databaseBasePath = resolveProjectPath(config.databasePath);

// Verify databaseBasePath is a writable directory
try {
    const stat = fs.statSync(databaseBasePath);
    if (!stat.isDirectory()) {
        throw new Error(`databasePath "${databaseBasePath}" is not a directory`);
    }
    fs.accessSync(databaseBasePath, fs.constants.W_OK);
} catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`databasePath "${databaseBasePath}" does not exist`);
    }
    if ((err as NodeJS.ErrnoException).code === 'EACCES') {
        throw new Error(`databasePath "${databaseBasePath}" is not writable`);
    }
    throw err;
}


// Initialize indexeddbshim with Node.js-compatible settings
// checkOrigin: false - required for Node.js (no window.location)
indexeddbshim(globalThis as Parameters<typeof indexeddbshim>[0], {
    checkOrigin: false,
    databaseBasePath,
});

// Re-export for explicit use if needed
export { indexeddbshim };
