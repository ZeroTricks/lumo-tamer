/**
 * BaseAuthProvider - Abstract base class for all auth providers
 *
 * Provides common implementations for:
 * - initialize() - Load tokens, validate method, call hooks
 * - Token getters (uid, accessToken, keyPassword, cached keys)
 * - API creation
 * - Token file I/O
 * - Token refresh (with customizable hook)
 *
 * Subclasses customize via hooks:
 * - validateMethod() - Override for custom method matching
 * - onAfterLoad() - Override for post-load setup
 *
 * Subclasses implement:
 * - isValid() / isNearExpiry() - Validity checking
 * - getStatus() - Status reporting
 * - supportsPersistence() - Persistence capability
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { logger } from '../../app/logger.js';
import { createProtonApi } from '../api-factory.js';
import { refreshWithRefreshToken, canRefreshWithToken } from '../token-refresh.js';
import type {
    AuthProvider,
    AuthProviderStatus,
    AuthMethod,
    StoredTokens,
    ProtonApi,
    CachedUserKey,
    CachedMasterKey,
} from '../types.js';

export abstract class BaseAuthProvider implements AuthProvider {
    abstract readonly method: AuthMethod;
    protected tokens: StoredTokens | null = null;
    protected tokenCachePath: string;

    constructor(tokenCachePath: string) {
        this.tokenCachePath = tokenCachePath;
    }

    // === Abstract methods (provider-specific) ===

    abstract isValid(): boolean;
    abstract isNearExpiry(): boolean;
    abstract getStatus(): AuthProviderStatus;
    abstract supportsPersistence(): boolean;

    // === Initialize (common flow with hooks) ===

    /**
     * Initialize the provider by loading and validating tokens.
     * Subclasses customize via validateMethod() and onAfterLoad() hooks.
     */
    async initialize(): Promise<void> {
        this.tokens = this.loadTokensFromFile();
        this.validateMethod();
        this.validateTokens();
        await this.onAfterLoad();
    }

    /**
     * Validate that the loaded tokens match this provider's method.
     * Override in subclass for custom matching (e.g., login accepts missing method).
     * @throws Error if method doesn't match
     */
    protected validateMethod(): void {
        if (this.tokens?.method !== this.method) {
            throw new Error(
                `Token file is not from ${this.method} auth (method: ${this.tokens?.method}).\n` +
                'Run: npm run auth'
            );
        }
    }

    /**
     * Hook called after tokens are loaded and validated.
     * Override in subclass for additional setup (e.g., decrypt keyPassword).
     */
    protected async onAfterLoad(): Promise<void> {
        // Default: no-op
    }

    // === Concrete implementations (shared by all) ===

    getUid(): string {
        if (!this.tokens?.uid) {
            throw new Error('Not authenticated');
        }
        return this.tokens.uid;
    }

    getAccessToken(): string {
        if (!this.tokens?.accessToken) {
            throw new Error('Not authenticated');
        }
        return this.tokens.accessToken;
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

    createApi(): ProtonApi {
        if (!this.tokens?.uid || !this.tokens?.accessToken) {
            throw new Error('Not authenticated');
        }

        return createProtonApi({
            uid: this.tokens.uid,
            accessToken: this.tokens.accessToken,
        });
    }

    // === Token refresh ===

    /**
     * Refresh tokens using /auth/refresh endpoint.
     * Can be overridden by subclasses for custom behavior.
     */
    async refresh(): Promise<void> {
        if (!this.tokens || !canRefreshWithToken(this.tokens)) {
            throw new Error('No refresh token available');
        }

        const refreshed = await refreshWithRefreshToken(this.tokens);
        this.tokens = { ...this.tokens, ...refreshed };

        // Hook for subclass customization (e.g., browser updates extractedAt)
        this.onAfterRefresh();

        this.saveTokensToFile();

        logger.info({
            method: this.method,
            hasAccessToken: !!this.tokens.accessToken,
            hasRefreshToken: !!this.tokens.refreshToken,
        }, 'Token refresh successful');
    }

    /**
     * Hook called after token refresh, before saving.
     * Override in subclass to customize (e.g., update extractedAt).
     */
    protected onAfterRefresh(): void {
        // Default: no-op
    }

    // === Protected helpers for token file I/O ===

    /**
     * Load tokens from the cache file.
     * @throws Error if file doesn't exist
     */
    protected loadTokensFromFile(): StoredTokens {
        if (!existsSync(this.tokenCachePath)) {
            throw new Error(`Token file not found: ${this.tokenCachePath}`);
        }
        const data = readFileSync(this.tokenCachePath, 'utf-8');
        return JSON.parse(data) as StoredTokens;
    }

    /**
     * Save current tokens to the cache file.
     */
    protected saveTokensToFile(): void {
        if (!this.tokens) return;
        writeFileSync(this.tokenCachePath, JSON.stringify(this.tokens, null, 2));
    }

    /**
     * Validate that tokens have required fields.
     * @throws Error if missing uid or accessToken
     */
    protected validateTokens(): void {
        if (!this.tokens?.uid || !this.tokens?.accessToken) {
            throw new Error(
                'Token file missing uid or accessToken.\n' +
                'Run the appropriate extraction/auth command for your auth method.'
            );
        }
    }
}
