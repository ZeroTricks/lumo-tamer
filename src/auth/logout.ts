/**
 * Logout - Session revocation and cleanup
 *
 * Implements proper logout by:
 * 1. Calling Proton's session revocation API (DELETE /core/v4/auth)
 * 2. Deleting the local encrypted vault
 *
 * Based on Proton WebClients implementation in:
 * packages/shared/lib/api/auth.ts - revoke()
 * packages/shared/lib/authentication/logout.ts - handleLogout()
 */

import { logger } from '../app/logger.js';
import { deleteVault } from './vault/index.js';
import type { ProtonApi } from './types.js';

/**
 * Revoke the current session on Proton's servers
 *
 * Calls DELETE /core/v4/auth to invalidate the access token.
 * This is the same endpoint used by Proton WebClients.
 *
 * @param api - Authenticated ProtonApi instance
 */
export async function revokeSession(api: ProtonApi): Promise<void> {
    try {
        logger.info('Revoking session on Proton servers...');

        await api({
            url: 'core/v4/auth',
            method: 'delete',
        });

        logger.info('Session revoked successfully');
    } catch (error) {
        // Log but don't fail - token might already be invalid or expired
        logger.warn({ error }, 'Session revoke failed (may already be invalid)');
    }
}

/**
 * Delete the local encrypted vault
 *
 * @param vaultPath - Path to the vault file (e.g., sessions/vault.enc)
 */
export async function deleteTokenCache(vaultPath: string): Promise<void> {
    await deleteVault(vaultPath);
}

export interface LogoutOptions {
    /** ProtonApi instance for session revocation */
    api: ProtonApi;
    /** Path to the encrypted vault */
    vaultPath: string;
    /** Whether to call the revoke API (default: true) */
    revokeRemote?: boolean;
    /** Whether to delete the local vault (default: true) */
    deleteLocal?: boolean;
}

/**
 * Perform a complete logout
 *
 * 1. Revokes the session on Proton's servers (optional)
 * 2. Deletes the local encrypted vault (optional)
 *
 * @param options - Logout options
 */
export async function logout(options: LogoutOptions): Promise<void> {
    const { api, vaultPath, revokeRemote = true, deleteLocal = true } = options;

    logger.info('Starting logout...');

    // 1. Revoke session on Proton servers
    if (revokeRemote) {
        await revokeSession(api);
    }

    // 2. Delete local encrypted vault
    if (deleteLocal) {
        await deleteTokenCache(vaultPath);
    }

    logger.info('Logout complete');
}
