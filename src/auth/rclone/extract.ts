/**
 * Extract tokens from rclone config and save to sessions/auth-tokens.json
 *
 * Usage: npm run extract-rclone
 *
 * This extracts tokens from an existing rclone protondrive configuration
 * and saves them in the unified token format used by all auth providers.
 */

import { writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { parseRcloneConfig } from './parser.js';
import { authConfig } from '../../app/config.js';
import { logger } from '../../app/logger.js';
import { resolveProjectPath } from '../../app/paths.js';
import type { StoredTokens } from '../types.js';

// Get rclone config from auth config
const rclonePath = authConfig?.rclone?.configPath ?? '~/.config/rclone/rclone.conf';
const remoteName = authConfig?.rclone?.configSection;
const outputPath = resolveProjectPath(authConfig.tokenPath);

async function extractRcloneTokens(): Promise<void> {
    logger.info('=== Rclone Token Extraction ===');

    if (!remoteName) {
        logger.error('auth.rclone.configSection is required in config.yaml');
        logger.error('Example config:');
        logger.error('  auth:');
        logger.error('    method: rclone');
        logger.error('    rclone:');
        logger.error('      configPath: ~/.config/rclone/rclone.conf');
        logger.error('      configSection: proton');
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
