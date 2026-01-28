/**
 * Rclone Authentication Entry Point
 *
 * Prompts the user to paste their rclone protondrive config section,
 * then saves tokens in the unified format used by all auth providers.
 * Used by CLI (npm run auth) for rclone authentication method.
 */

import * as readline from 'readline';
import { parseRcloneSection } from './parser.js';
import { authConfig } from '../../app/config.js';
import { logger } from '../../app/logger.js';
import { resolveProjectPath } from '../../app/paths.js';
import { writeVault, type VaultKeyConfig } from '../vault/index.js';
import type { StoredTokens } from '../types.js';

/**
 * Read multi-line input from stdin until an empty line is entered
 */
async function readMultilineInput(): Promise<string> {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    console.log('Paste your rclone protondrive config section below.');
    console.log('You can find it in ~/.config/rclone/rclone.conf');
    console.log('');
    console.log('Example:');
    console.log('  [proton]');
    console.log('  type = protondrive');
    console.log('  client_uid = ...');
    console.log('  client_access_token = ...');
    console.log('  client_refresh_token = ...');
    console.log('  client_salted_key_pass = ...');
    console.log('');
    console.log('(Press Enter on an empty line when done)\n');

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
 */
export async function runRcloneAuthentication(): Promise<void> {
    const content = await readMultilineInput();

    if (!content.trim()) {
        throw new Error('No input provided');
    }

    // Parse the pasted content
    const rcloneTokens = parseRcloneSection(content);

    // Convert to unified StoredTokens format
    const tokens: StoredTokens = {
        method: 'rclone',
        uid: rcloneTokens.uid,
        accessToken: rcloneTokens.accessToken,
        refreshToken: rcloneTokens.refreshToken,
        keyPassword: rcloneTokens.keyPassword,
        extractedAt: new Date().toISOString(),
    };

    // Write tokens to encrypted vault
    const vaultPath = resolveProjectPath(authConfig.vault.path);
    const keyConfig: VaultKeyConfig = {
        keychain: authConfig.vault.keychain,
        keyFilePath: authConfig.vault.keyFilePath,
    };

    await writeVault(vaultPath, tokens, keyConfig);

    logger.info({ vaultPath }, 'Tokens saved to encrypted vault');
    logger.info({
        uid: tokens.uid.slice(0, 12) + '...',
        hasKeyPassword: !!tokens.keyPassword,
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
