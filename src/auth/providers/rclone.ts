/**
 * Rclone Auth Provider
 *
 * Uses tokens extracted from rclone config via npm run extract-rclone.
 * Supports automatic token refresh since rclone extraction includes refreshToken.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { logger } from '../../app/logger.js';
import { authConfig } from '../../app/config.js';
import { resolveProjectPath } from '../../app/paths.js';
import { createProtonApi } from '../api-factory.js';
import { refreshWithRefreshToken } from '../token-refresh.js';
import type { AuthProvider, AuthProviderStatus, StoredTokens, ProtonApi } from '../types.js';

export class RcloneAuthProvider implements AuthProvider {
    readonly method = 'rclone' as const;

    private tokens: StoredTokens | null = null;
    private tokenCachePath: string;

    constructor() {
        this.tokenCachePath = resolveProjectPath(authConfig?.tokenCachePath ?? 'sessions/auth-tokens.json');
    }

    async initialize(): Promise<void> {
        if (!existsSync(this.tokenCachePath)) {
            throw new Error(
                `Token file not found: ${this.tokenCachePath}\n` +
                'Run: npm run extract-rclone'
            );
        }

        const data = readFileSync(this.tokenCachePath, 'utf-8');
        this.tokens = JSON.parse(data) as StoredTokens;

        // Validate we have rclone tokens
        if (this.tokens.method !== 'rclone') {
            throw new Error(
                `Token file is not from rclone extraction (method: ${this.tokens.method}).\n` +
                'Run: npm run extract-rclone'
            );
        }

        logger.info({
            uid: this.tokens.uid.slice(0, 12) + '...',
            hasKeyPassword: !!this.tokens.keyPassword,
            extractedAt: this.tokens.extractedAt,
        }, 'Rclone tokens loaded');

        if (!this.tokens.keyPassword) {
            logger.warn('keyPassword missing from rclone tokens - conversation persistence disabled');
        }
    }

    getUid(): string {
        if (!this.tokens) {
            throw new Error('Not authenticated - no UID available');
        }
        return this.tokens.uid;
    }

    getKeyPassword(): string | undefined {
        return this.tokens?.keyPassword;
    }

    createApi(): ProtonApi {
        if (!this.tokens) {
            throw new Error('Not authenticated');
        }

        return createProtonApi({
            uid: this.tokens.uid,
            accessToken: this.tokens.accessToken,
        });
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

    /**
     * Refresh tokens using Proton's /auth/refresh endpoint
     *
     * Rclone extraction includes refreshToken, so we can refresh
     * without needing rclone or browser.
     */
    async refresh(): Promise<void> {
        if (!this.tokens?.refreshToken) {
            throw new Error('No refresh token available - re-run: npm run extract-rclone');
        }

        logger.info('Refreshing rclone tokens...');
        const refreshed = await refreshWithRefreshToken(this.tokens);

        // Update tokens, preserving keyPassword and other metadata
        this.tokens = {
            ...this.tokens,
            ...refreshed,
        };

        this.saveTokens();
        logger.info('Rclone token refresh successful');
    }

    private saveTokens(): void {
        if (!this.tokens) return;
        writeFileSync(
            this.tokenCachePath,
            JSON.stringify(this.tokens, null, 2),
            { mode: 0o600 }
        );
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
