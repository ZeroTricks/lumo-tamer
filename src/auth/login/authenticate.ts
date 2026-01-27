/**
 * Login Authentication Entry Point
 *
 * Run interactive login using username/password credentials.
 * Used by CLI (npm run auth) for login authentication method.
 */

import { writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { authConfig } from '../../app/config.js';
import { logger } from '../../app/logger.js';
import { resolveProjectPath } from '../../app/paths.js';
import { runProtonAuth } from './proton-auth-cli.js';
import type { StoredTokens } from '../types.js';

/**
 * Run login authentication
 *
 * Runs the Go binary for SRP authentication and saves tokens.
 */
export async function runLoginAuthentication(): Promise<void> {
    const binaryPath = resolveProjectPath(authConfig.login.binaryPath);
    const outputPath = resolveProjectPath(authConfig.tokenPath);

    // Run the Go binary (interactive prompts for credentials)
    const result = await runProtonAuth(binaryPath);

    // Convert to unified StoredTokens format
    const tokens: StoredTokens = {
        method: 'login',
        uid: result.uid,
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        keyPassword: result.keyPassword,
        expiresAt: result.expiresAt || new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString(),
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
        expiresAt: tokens.expiresAt,
    }, 'Login authentication complete');
}
