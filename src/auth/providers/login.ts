/**
 * Login Auth Provider
 *
 * Uses Proton's SRP protocol via go-proton-api binary for direct credential login.
 * Supports automatic token refresh.
 */

import { logger } from '../../app/logger.js';
import { authConfig, getConversationsConfig } from '../../app/config.js';
import { resolveProjectPath } from '../../app/paths.js';
import { fetchKeys } from '../fetch-keys.js';
import { BaseAuthProvider } from './base.js';
import type { AuthProviderStatus, StoredTokens } from '../types.js';

export class LoginAuthProvider extends BaseAuthProvider {
    readonly method = 'login' as const;

    constructor() {
        super(resolveProjectPath(authConfig.tokenPath));
    }

    async initialize(): Promise<void> {
        // Load tokens from file (throws if missing)
        const cached = this.loadTokensFromFile();

        // Accept tokens without method field (created by Go binary) or with method: 'login'
        const isLoginTokens = !cached.method || cached.method === 'login';
        if (!isLoginTokens) {
            throw new Error(
                `Token file is not from login auth (method: ${cached.method}).\n` +
                'Run: npm run auth and select login'
            );
        }

        if (this.isExpired(cached)) {
            throw new Error(
                'Login tokens have expired.\n' +
                'Run: npm run auth and select login'
            );
        }

        // Ensure method is set for consistency
        this.tokens = { ...cached, method: 'login' };
        logger.info(
            { expiresAt: cached.expiresAt },
            'Loaded cached login auth tokens'
        );

        // Fetch keys if not already cached
        await this.fetchAndCacheKeys();
    }

    private async fetchAndCacheKeys(): Promise<void> {
        if (!getConversationsConfig().sync.enabled) return;
        if (!this.supportsPersistence()) return;  // Login tokens lack lumo scope for spaces API
        if (!this.tokens) return;
        if (this.tokens.userKeys && this.tokens.masterKeys) {
            logger.debug('Keys already cached, skipping fetch');
            return;
        }

        logger.info('Fetching keys for persistence...');
        try {
            const keys = await fetchKeys(this.createApi());
            if (keys.userKeys) this.tokens.userKeys = keys.userKeys;
            if (keys.masterKeys) this.tokens.masterKeys = keys.masterKeys;
            this.saveTokensToFile();
            logger.info('Keys cached successfully');
        } catch (err) {
            logger.warn({ err }, 'Failed to fetch keys - persistence may not work');
        }
    }

    supportsPersistence(): boolean {
        return false;  // Login tokens lack lumo scope for spaces API
    }

    isValid(): boolean {
        if (!this.tokens) return false;
        return !this.isExpired(this.tokens);
    }

    isNearExpiry(): boolean {
        if (!this.tokens?.expiresAt) return false;
        const expiresAt = new Date(this.tokens.expiresAt);
        const fiveMinutesFromNow = new Date(Date.now() + 5 * 60 * 1000);
        return expiresAt <= fiveMinutesFromNow;
    }

    getStatus(): AuthProviderStatus {
        const status: AuthProviderStatus = {
            method: 'login',
            source: this.tokenCachePath,
            valid: false,
            details: {},
            warnings: [],
        };

        if (!this.tokens) {
            status.warnings.push('No tokens loaded');
            status.warnings.push('Run: npm run auth and select login');
            return status;
        }

        status.details.uid = this.tokens.uid.slice(0, 12) + '...';
        status.details.hasKeyPassword = !!this.tokens.keyPassword;
        status.details.extractedAt = this.tokens.extractedAt;

        if (this.tokens.expiresAt) {
            const expiresAt = new Date(this.tokens.expiresAt);
            const now = new Date();
            const hoursRemaining = (expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60);

            status.details.expiresAt = this.tokens.expiresAt;

            if (hoursRemaining <= 0) {
                status.warnings.push('Tokens have expired');
                status.warnings.push('Run: npm run auth and select login');
            } else if (hoursRemaining < 1) {
                status.warnings.push(`Tokens expire in ${Math.round(hoursRemaining * 60)} minutes`);
                status.valid = true;
            } else {
                status.details.expiresIn = `${hoursRemaining.toFixed(1)} hours`;
                status.valid = true;
            }
        } else {
            status.details.expiresAt = 'unknown';
            status.valid = true;
        }

        if (!this.tokens.keyPassword) {
            status.warnings.push('keyPassword missing - conversation persistence disabled');
        }

        return status;
    }

    private isExpired(tokens: StoredTokens): boolean {
        if (!tokens.expiresAt) return false;
        return new Date(tokens.expiresAt) <= new Date();
    }
}
