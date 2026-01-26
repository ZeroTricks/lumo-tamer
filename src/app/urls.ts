/**
 * Proton domain constants
 *
 * These are fixed production URLs. Changing them requires code changes
 * since different auth methods and API endpoints are domain-specific.
 */

export const PROTON_URLS = {
    // Lumo domain - for Lumo-specific APIs and browser auth
    LUMO_BASE: 'https://lumo.proton.me',
    LUMO_API: 'https://lumo.proton.me/api',

    // Account domain - for account APIs, SRP/rclone auth
    ACCOUNT_BASE: 'https://account.proton.me',
    ACCOUNT_API: 'https://account.proton.me/api',
} as const;
