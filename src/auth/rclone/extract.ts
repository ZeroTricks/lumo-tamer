/**
 * Extract tokens from rclone config and save to sessions/auth-tokens.json
 *
 * Usage: npm run extract-rclone
 *
 * This extracts tokens from an existing rclone protondrive configuration
 * and saves them in the unified token format used by all auth providers.
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { parseRcloneConfig } from './parser.js';
import { authConfig } from '../../config.js';
import { logger } from '../../logger.js';
import type { StoredTokens } from '../types.js';

// Get rclone config from auth config
const rclonePath = authConfig?.rclonePath ?? '~/.config/rclone/rclone.conf';
const remoteName = authConfig?.rcloneRemote;
const outputPath = authConfig?.tokenCachePath ?? 'sessions/auth-tokens.json';

async function extractRcloneTokens(): Promise<void> {
    logger.info('=== Rclone Token Extraction ===');

    if (!remoteName) {
        logger.error('auth.rcloneRemote is required in config.yaml');
        logger.error('Example config:');
        logger.error('  auth:');
        logger.error('    method: rclone');
        logger.error('    rclonePath: ~/.config/rclone/rclone.conf');
        logger.error('    rcloneRemote: proton');
        process.exit(1);
    }

    logger.info({ rclonePath, remoteName }, 'Reading rclone config');

    try {
        // Parse rclone config
        const rcloneTokens = parseRcloneConfig(rclonePath, remoteName);

        // Convert to unified StoredTokens format
        const tokens: StoredTokens = {
            method: 'rclone',
            uid: rcloneTokens.uid,
            accessToken: rcloneTokens.accessToken,
            refreshToken: rcloneTokens.refreshToken,
            keyPassword: rcloneTokens.keyPassword,
            extractedAt: new Date().toISOString(),
            // Note: rclone doesn't track expiry - tokens are refreshed externally
        };

        // Ensure output directory exists
        mkdirSync(join(process.cwd(), 'sessions'), { recursive: true });

        // Write tokens
        const fullOutputPath = join(process.cwd(), outputPath);
        writeFileSync(fullOutputPath, JSON.stringify(tokens, null, 2), { mode: 0o600 });

        logger.info({ outputPath: fullOutputPath }, 'Tokens saved');
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
