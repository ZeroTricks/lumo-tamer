/**
 * Extract tokens from rclone config and save to sessions/auth-tokens.json
 *
 * Usage: npm run extract-rclone
 *
 * Prompts the user to paste their rclone protondrive config section,
 * then saves tokens in the unified format used by all auth providers.
 */

import * as readline from 'readline';
import { writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { parseRcloneSection } from './parser.js';
import { authConfig } from '../../app/config.js';
import { logger } from '../../app/logger.js';
import { resolveProjectPath } from '../../app/paths.js';
import type { StoredTokens } from '../types.js';

const outputPath = resolveProjectPath(authConfig.tokenPath);

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

async function extractRcloneTokens(): Promise<void> {
    logger.info('=== Rclone Token Extraction ===');

    try {
        const content = await readMultilineInput();

        if (!content.trim()) {
            logger.error('No input provided');
            process.exit(1);
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

        // Ensure output directory exists
        mkdirSync(dirname(outputPath), { recursive: true });

        // Write tokens
        writeFileSync(outputPath, JSON.stringify(tokens, null, 2), { mode: 0o600 });

        logger.info({ outputPath }, 'Tokens saved');
        logger.info({
            uid: tokens.uid.slice(0, 12) + '...',
            hasKeyPassword: !!tokens.keyPassword,
        }, 'Extraction complete');

        logger.info('');
        logger.info('You can now run: npm run dev');

    } catch (error) {
        logger.error({ error }, 'Extraction failed');
        process.exit(1);
    }
}

extractRcloneTokens();
