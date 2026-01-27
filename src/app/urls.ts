/**
 * Proton domain constants (lumo-bridge specific)
 *
 * These are fixed production URLs for Proton services.
 * Unlike proton-upstream/ shims, this file is NOT synced from WebClients.
 * URLs are intentionally not configurable - different environments would probably
 * require code changes to auth and API logic.
 */

export const PROTON_URLS = {
    // Lumo domain - for Lumo-specific APIs and browser auth
    LUMO_BASE: 'https://lumo.proton.me',
    LUMO_API: 'https://lumo.proton.me/api',

    // Account domain - for account APIs, SRP/rclone auth
    ACCOUNT_BASE: 'https://account.proton.me',
    ACCOUNT_API: 'https://account.proton.me/api',
} as const;
