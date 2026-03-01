/**
 * Minimal shim for lib/lumo-api-client/index.ts
 *
 * The upstream barrel file imports many modules we don't have (core/client, core/network, etc).
 * This shim re-exports only what's needed by utils.ts and other local consumers.
 *
 * Source: https://github.com/ProtonMail/WebClients/blob/main/applications/lumo/src/app/lib/lumo-api-client/index.ts
 */

// Re-export types from core/types.ts (which re-exports from ../../types.ts)
export { type RequestId, Role, type Turn, isTurn } from './core/types';
