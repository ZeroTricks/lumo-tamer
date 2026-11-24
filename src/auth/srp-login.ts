/**
 * Shared SRP login flow: run a proton-auth binary and persist the result to the vault.
 * Used by both the `login` and `login-captcha` auth methods.
 */

import { logger } from '../app/logger.js';
import { resolveProjectPath } from '../app/paths.js';
import { authConfig } from '../app/config.js';
import { runProtonAuth } from './proton-auth-cli.js';
import { readVault, writeVault, type VaultKeyConfig } from './vault/index.js';
import type { AuthMethod, StoredTokens } from './types.js';

/**
 * Run SRP authentication via a proton-auth binary and save tokens to the encrypted vault.
 * Preserves sync data (userKeys, masterKeys) from an existing vault if present.
 */
export async function runSrpAuthentication(
    method: AuthMethod,
    binaryPath: string,
    args: string[],
    buildHint?: string
): Promise<void> {
    const result = await runProtonAuth(binaryPath, args, undefined, buildHint);

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
        method,
        uid: result.uid,
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        keyPassword: result.keyPassword,
        expiresAt: result.expiresAt || new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString(),
        extractedAt: new Date().toISOString(),
        userKeys: existingTokens.userKeys,
        masterKeys: existingTokens.masterKeys,
    };

    // Generate local keys if no existing keys and keyPassword available
    // These enable local persistence without sync capability
    if (!tokens.userKeys?.length && tokens.keyPassword) {
        const { generateLocalKeys } = await import('./key-generator.js');
        const generated = await generateLocalKeys(tokens.keyPassword);
        tokens.userKeys = generated.userKeys;
        tokens.masterKeys = generated.masterKeys;
        logger.info('Generated local encryption keys (sync disabled)');
    }

    await writeVault(vaultPath, tokens, keyConfig);

    const preservedSyncData = existingTokens.userKeys?.length || existingTokens.masterKeys?.length;

    logger.info({ vaultPath }, 'Tokens saved to encrypted vault');
    logger.info({
        method,
        uid: tokens.uid.slice(0, 12) + '...',
        hasKeyPassword: !!tokens.keyPassword,
        expiresAt: tokens.expiresAt,
        preservedSyncData: !!preservedSyncData,
    }, 'Login authentication complete');
}
