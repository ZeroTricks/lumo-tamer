/**
 * Login Authentication Entry Point
 *
 * Run interactive login using username/password credentials.
 * Used by CLI (tamer auth) for login authentication method.
 */

import { authConfig } from '../../app/config.js';
import { logger } from '../../app/logger.js';
import { resolveProjectPath } from '../../app/paths.js';
import { runProtonAuth } from './proton-auth-cli.js';
import { readVault, writeVault, type VaultKeyConfig } from '../vault/index.js';
import type { StoredTokens } from '../types.js';

/**
 * Run login authentication
 *
 * Runs the Go binary for SRP authentication and saves tokens to encrypted vault.
 * Preserves sync data (userKeys, masterKeys) from existing vault if present.
 */
export async function runLoginAuthentication(): Promise<void> {
    const binaryPath = resolveProjectPath(authConfig.login.binaryPath);

    // Run the Go binary (interactive prompts for credentials)
    const result = await runProtonAuth(binaryPath);

    const vaultPath = resolveProjectPath(authConfig.vault.path);
    const keyConfig: VaultKeyConfig = {
        keychain: authConfig.vault.keychain,
        keyFilePath: authConfig.vault.keyFilePath,
    };

    // Try to load existing vault to preserve sync data
    let existingTokens: Partial<StoredTokens> = {};
    try {
        existingTokens = await readVault(vaultPath, keyConfig);
    } catch {
        // No existing vault, start fresh
    }

    // Convert to unified StoredTokens format
    // Preserve sync data (userKeys, masterKeys) from existing vault if present
    // (UID is a session id that changes each login, not a user id)
    const tokens: StoredTokens = {
        method: 'login',
        uid: result.uid,
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        keyPassword: result.keyPassword,
        expiresAt: result.expiresAt || new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString(),
        extractedAt: new Date().toISOString(),
        userKeys: existingTokens.userKeys,
        masterKeys: existingTokens.masterKeys,
    };

    await writeVault(vaultPath, tokens, keyConfig);

    const preservedSyncData = existingTokens.userKeys?.length || existingTokens.masterKeys?.length;

    logger.info({ vaultPath }, 'Tokens saved to encrypted vault');
    logger.info({
        uid: tokens.uid.slice(0, 12) + '...',
        hasKeyPassword: !!tokens.keyPassword,
        expiresAt: tokens.expiresAt,
        preservedSyncData: !!preservedSyncData,
    }, 'Login authentication complete');
}
