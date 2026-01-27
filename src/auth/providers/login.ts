/**
 * Login Auth Provider
 *
 * Uses Proton's SRP protocol via go-proton-api binary for direct credential login.
 * Supports automatic token refresh.
 */

import { existsSync } from 'fs';
import { logger } from '../../app/logger.js';
import { authConfig, getConversationsConfig } from '../../app/config.js';
import { resolveProjectPath } from '../../app/paths.js';
import { runProtonAuth } from '../login/proton-auth-cli.js';
import { fetchKeys } from '../fetch-keys.js';
import { BaseAuthProvider } from './base.js';
import type { AuthProviderStatus, StoredTokens } from '../types.js';

export class LoginAuthProvider extends BaseAuthProvider {
    readonly method = 'login' as const;

    private binaryPath: string;

    constructor() {
        super(resolveProjectPath(authConfig.tokenPath));
        this.binaryPath = resolveProjectPath(authConfig.login.binaryPath);
    }

    async initialize(): Promise<void> {
        // Try to load cached tokens first
        if (existsSync(this.tokenCachePath)) {
            try {
                const cached = this.loadCachedTokensSafe();
                // Accept tokens without method field (created by Go binary) or with method: 'login'
                const isLoginTokens = cached && (!cached.method || cached.method === 'login');
                if (isLoginTokens && !this.isExpired(cached)) {
                    // Ensure method is set for consistency
                    this.tokens = { ...cached, method: 'login' };
                    logger.info(
                        { expiresAt: cached.expiresAt },
                        'Loaded cached login auth tokens'
                    );
                    // Fetch keys if not already cached
                    await this.fetchAndCacheKeys();
                    return;
                }
                if (cached && isLoginTokens) {
                    logger.info('Cached login tokens expired, need to re-authenticate');
                }
            } catch (err) {
                logger.warn({ err }, 'Failed to load cached tokens');
            }
        }

        // Need fresh authentication
        await this.authenticate();

        // Fetch keys for persistence if enabled and not already cached
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

    private async authenticate(): Promise<void> {
        const result = await runProtonAuth(this.binaryPath, this.tokenCachePath);

        // If output went to file, read it back
        if (!result.accessToken && existsSync(this.tokenCachePath)) {
            this.tokens = this.loadCachedTokensSafe();
        } else {
            this.tokens = {
                method: 'login',
                uid: result.uid,
                accessToken: result.accessToken,
                refreshToken: result.refreshToken,
                keyPassword: result.keyPassword,
                expiresAt: result.expiresAt || new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString(),
                extractedAt: new Date().toISOString(),
            };
            this.saveTokensToFile();
        }

        logger.info('Login authentication successful');
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

    // === Login-specific helpers ===

    /**
     * Load cached tokens, returning null on error instead of throwing.
     */
    private loadCachedTokensSafe(): StoredTokens | null {
        try {
            return this.loadTokensFromFile();
        } catch {
            return null;
        }
    }

    private isExpired(tokens: StoredTokens): boolean {
        if (!tokens.expiresAt) return false;
        return new Date(tokens.expiresAt) <= new Date();
    }
}
