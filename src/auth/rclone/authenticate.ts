/**
 * Rclone Authentication Entry Point
 *
 * Prompts the user to paste their rclone protondrive config section,
 * then saves tokens in the unified format used by all auth providers.
 * Used by CLI (tamer auth) for rclone authentication method.
 */

import * as readline from 'readline';
import { parseRcloneSection } from './parser.js';
import { authConfig } from '../../app/config.js';
import { logger } from '../../app/logger.js';
import { resolveProjectPath } from '../../app/paths.js';
import { readVault, writeVault, type VaultKeyConfig } from '../vault/index.js';
import type { StoredTokens } from '../types.js';
import { print } from '../../app/terminal.js';

/**
 * Read multi-line input from stdin until an empty line is entered
 */
async function readMultilineInput(): Promise<string> {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    print('Paste your rclone protondrive config section below.');
    print('You can find it in ~/.config/rclone/rclone.conf (Linux/macOS) or `%APPDATA%\\rclone\\rclone.conf` (Windows)');
    print('');
    print('Example:');
    print('  [lumo]');
    print('  type = protondrive');
    print('  client_uid = ...');
    print('  client_access_token = ...');
    print('  client_refresh_token = ...');
    print('  client_salted_key_pass = ...');
    print('');
    print('(Press Enter on an empty line when done)\n');

    const lines: string[] = [];

    for await (const line of rl) {
        if (line === '' && lines.length > 0) {
            break;
        }
        lines.push(line);
    }

    rl.close();
    return lines.join('\n');
}

/**
 * Run rclone authentication
 *
 * Prompts for rclone config paste, parses tokens, and saves to encrypted vault.
 * Preserves sync data (userKeys, masterKeys) from existing vault if present.
 */
export async function runRcloneAuthentication(): Promise<void> {
    const content = await readMultilineInput();

    if (!content.trim()) {
        throw new Error('No input provided');
    }

    // Parse the pasted content
    const rcloneTokens = parseRcloneSection(content);

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

    const extractedAt = new Date().toISOString();

    // Convert to unified StoredTokens format
    // Preserve sync data (userKeys, masterKeys) from existing vault if present
    // (UID is a session id that changes each login, not a user id)
    const tokens: StoredTokens = {
        method: 'rclone',
        uid: rcloneTokens.uid,
        accessToken: rcloneTokens.accessToken,
        refreshToken: rcloneTokens.refreshToken,
        keyPassword: rcloneTokens.keyPassword,
        extractedAt,
        // Set expiresAt for unified validity checking (conservative 12h estimate)
        expiresAt: new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString(),
        userKeys: existingTokens.userKeys,
        masterKeys: existingTokens.masterKeys,
    };

    await writeVault(vaultPath, tokens, keyConfig);

    const preservedSyncData = existingTokens.userKeys?.length || existingTokens.masterKeys?.length;

    logger.info({ vaultPath }, 'Tokens saved to encrypted vault');
    logger.info({
        uid: tokens.uid.slice(0, 12) + '...',
        hasKeyPassword: !!tokens.keyPassword,
        preservedSyncData: !!preservedSyncData,
    }, 'Extraction complete');
}

// Only run when invoked directly (not when imported)
const isDirectInvocation = import.meta.url === `file://${process.argv[1]}`;
if (isDirectInvocation) {
    runRcloneAuthentication().catch(error => {
        logger.error({ error }, 'Extraction failed');
        process.exit(1);
    });
}
