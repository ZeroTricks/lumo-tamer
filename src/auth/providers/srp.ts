/**
 * SRP Auth Provider
 *
 * Uses Proton's SRP protocol via go-proton-api binary.
 * Supports automatic token refresh.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { logger } from '../../app/logger.js';
import { authConfig, getPersistenceConfig } from '../../app/config.js';
import { resolveProjectPath } from '../../app/paths.js';
import { runProtonAuth } from '../go-proton-api/proton-auth-cli.js';
import { createProtonApi } from '../api-factory.js';
import { fetchKeys } from '../fetch-keys.js';
import { refreshWithRefreshToken } from '../token-refresh.js';
import type { AuthProvider, AuthProviderStatus, StoredTokens, ProtonApi, CachedUserKey, CachedMasterKey } from '../types.js';

export class SRPAuthProvider implements AuthProvider {
    readonly method = 'srp' as const;

    private tokens: StoredTokens | null = null;
    private tokenCachePath: string;
    private binaryPath: string;

    constructor() {
        this.tokenCachePath = resolveProjectPath(authConfig?.tokenCachePath ?? 'sessions/auth-tokens.json');
        this.binaryPath = resolveProjectPath(authConfig?.binaryPath ?? './bin/proton-auth');
    }

    async initialize(): Promise<void> {
        // Try to load cached tokens first
        if (existsSync(this.tokenCachePath)) {
            try {
                const cached = this.loadCachedTokens();
                // Accept tokens without method field (created by Go binary) or with method: 'srp'
                const isSrpTokens = cached && (!cached.method || cached.method === 'srp');
                if (isSrpTokens && !this.isExpired(cached)) {
                    // Ensure method is set for consistency
                    this.tokens = { ...cached, method: 'srp' };
                    logger.info(
                        { expiresAt: cached.expiresAt },
                        'Loaded cached SRP auth tokens'
                    );
                    // Fetch keys if not already cached
                    await this.fetchAndCacheKeys();
                    return;
                }
                if (cached && isSrpTokens) {
                    logger.info('Cached SRP tokens expired, need to re-authenticate');
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
        if (!getPersistenceConfig()?.enabled) return;
        if (!this.supportsPersistence()) return;  // SRP can't use persistence anyway
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
            this.saveTokens();
            logger.info('Keys cached successfully');
        } catch (err) {
            logger.warn({ err }, 'Failed to fetch keys - persistence may not work');
        }
    }

    private async authenticate(): Promise<void> {
        logger.info('Starting SRP authentication (interactive)...');

        const result = await runProtonAuth(this.binaryPath, this.tokenCachePath);

        // If output went to file, read it back
        if (!result.accessToken && existsSync(this.tokenCachePath)) {
            this.tokens = this.loadCachedTokens();
        } else {
            this.tokens = {
                method: 'srp',
                uid: result.uid,
                accessToken: result.accessToken,
                refreshToken: result.refreshToken,
                keyPassword: result.keyPassword,
                expiresAt: result.expiresAt || new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString(),
                extractedAt: new Date().toISOString(),
            };
            this.saveTokens();
        }

        logger.info('SRP authentication successful');
    }

    async refresh(): Promise<void> {
        if (!this.tokens?.refreshToken) {
            throw new Error('No refresh token available');
        }

        logger.info('Refreshing SRP tokens...');
        const refreshed = await refreshWithRefreshToken(this.tokens);

        // Update tokens, preserving keyPassword and other metadata
        this.tokens = {
            ...this.tokens,
            ...refreshed,
        };

        this.saveTokens();
        logger.info('SRP token refresh successful');
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

    getCachedUserKeys(): CachedUserKey[] | undefined {
        return this.tokens?.userKeys;
    }

    getCachedMasterKeys(): CachedMasterKey[] | undefined {
        return this.tokens?.masterKeys;
    }

    supportsPersistence(): boolean {
        return false;  // SRP tokens lack lumo scope for spaces API
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
            method: 'srp',
            source: this.tokenCachePath,
            valid: false,
            details: {},
            warnings: [],
        };

        if (!this.tokens) {
            status.warnings.push('No tokens loaded');
            status.warnings.push('Run: ./bin/proton-auth -o sessions/auth-tokens.json');
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
                status.warnings.push('Re-run: ./bin/proton-auth -o sessions/auth-tokens.json');
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

    private loadCachedTokens(): StoredTokens | null {
        try {
            const data = readFileSync(this.tokenCachePath, 'utf-8');
            return JSON.parse(data) as StoredTokens;
        } catch {
            return null;
        }
    }

    private saveTokens(): void {
        if (!this.tokens) return;
        writeFileSync(
            this.tokenCachePath,
            JSON.stringify(this.tokens, null, 2),
            { mode: 0o600 }
        );
    }

    private isExpired(tokens: StoredTokens): boolean {
        if (!tokens.expiresAt) return false;
        return new Date(tokens.expiresAt) <= new Date();
    }
}
