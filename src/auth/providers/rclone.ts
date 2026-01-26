/**
 * Rclone Auth Provider
 *
 * Uses tokens extracted from rclone config via npm run extract-rclone.
 * Supports automatic token refresh since rclone extraction includes refreshToken.
 */

import { logger } from '../../app/logger.js';
import { authConfig } from '../../app/config.js';
import { resolveProjectPath } from '../../app/paths.js';
import { BaseAuthProvider } from './base.js';
import type { AuthProviderStatus } from '../types.js';

export class RcloneAuthProvider extends BaseAuthProvider {
    readonly method = 'rclone' as const;

    constructor() {
        super(resolveProjectPath(authConfig?.tokenCachePath ?? 'sessions/auth-tokens.json'));
    }

    async initialize(): Promise<void> {
        this.tokens = this.loadTokensFromFile();

        // Validate we have rclone tokens
        if (this.tokens.method !== 'rclone') {
            throw new Error(
                `Token file is not from rclone extraction (method: ${this.tokens.method}).\n` +
                'Run: npm run extract-rclone'
            );
        }

        this.validateTokens();

        logger.info({
            uid: this.tokens.uid.slice(0, 12) + '...',
            hasKeyPassword: !!this.tokens.keyPassword,
            extractedAt: this.tokens.extractedAt,
        }, 'Rclone tokens loaded');

        if (!this.tokens.keyPassword) {
            logger.warn('keyPassword missing from rclone tokens - conversation persistence disabled');
        }
    }

    isValid(): boolean {
        // Rclone doesn't track expiry - tokens are managed externally
        // We assume valid if we have tokens
        return !!this.tokens?.accessToken;
    }

    isNearExpiry(): boolean {
        // Check if tokens are near expiry (if we have expiresAt from a previous refresh)
        if (!this.tokens?.expiresAt) return false;
        const expiresAt = new Date(this.tokens.expiresAt);
        const fiveMinutesFromNow = new Date(Date.now() + 5 * 60 * 1000);
        return expiresAt <= fiveMinutesFromNow;
    }

    supportsPersistence(): boolean {
        return false;  // Rclone tokens lack lumo scope for spaces API
    }

    getStatus(): AuthProviderStatus {
        const status: AuthProviderStatus = {
            method: 'rclone',
            source: this.tokenCachePath,
            valid: false,
            details: {},
            warnings: [],
        };

        if (!this.tokens) {
            status.warnings.push(`Token file not found: ${this.tokenCachePath}`);
            status.warnings.push('Run: npm run extract-rclone');
            return status;
        }

        status.details.uid = this.tokens.uid?.slice(0, 12) + '...';
        status.details.hasKeyPassword = !!this.tokens.keyPassword;
        status.details.extractedAt = this.tokens.extractedAt;
        status.details.expiresAt = 'not tracked (managed by rclone)';

        if (!this.tokens.keyPassword) {
            status.warnings.push('keyPassword missing - conversation persistence disabled');
        }

        if (!this.tokens.accessToken) {
            status.warnings.push('Missing access token');
            status.warnings.push('Run: npm run extract-rclone');
        } else {
            status.valid = true;
        }

        return status;
    }
}
