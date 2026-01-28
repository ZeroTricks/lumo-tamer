/**
 * BaseAuthProvider - Abstract base class for all auth providers
 *
 * Provides common implementations for:
 * - initialize() - Load tokens from encrypted vault, validate method, call hooks
 * - Token getters (uid, accessToken, keyPassword, cached keys)
 * - API creation
 * - Token vault I/O (AES-256-GCM encrypted)
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

import { existsSync } from 'fs';
import { logger } from '../../app/logger.js';
import { createProtonApi } from '../api-factory.js';
import { refreshWithRefreshToken, canRefreshWithToken } from '../token-refresh.js';
import { readVault, writeVault } from '../vault/index.js';
import type { VaultKeyConfig } from '../vault/index.js';
import type {
    AuthProvider,
    AuthProviderStatus,
    AuthMethod,
    StoredTokens,
    ProtonApi,
    CachedUserKey,
    CachedMasterKey,
} from '../types.js';

export interface ProviderConfig {
    vaultPath: string;
    keyConfig: VaultKeyConfig;
}

export abstract class BaseAuthProvider implements AuthProvider {
    abstract readonly method: AuthMethod;
    protected tokens: StoredTokens | null = null;
    protected config: ProviderConfig;

    constructor(config: ProviderConfig) {
        this.config = config;
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
        this.tokens = await this.loadTokensFromVault();
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

        await this.saveTokensToVault();

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

    // === Protected helpers for vault I/O ===

    /**
     * Load tokens from the encrypted vault.
     * @throws Error if vault doesn't exist or can't be decrypted
     */
    protected async loadTokensFromVault(): Promise<StoredTokens> {
        const { vaultPath, keyConfig } = this.config;

        if (!existsSync(vaultPath)) {
            throw new Error(
                `Vault not found: ${vaultPath}\n` +
                'Run: npm run auth'
            );
        }

        return readVault(vaultPath, keyConfig);
    }

    /**
     * Save current tokens to the encrypted vault.
     */
    protected async saveTokensToVault(): Promise<void> {
        if (!this.tokens) return;
        const { vaultPath, keyConfig } = this.config;
        await writeVault(vaultPath, this.tokens, keyConfig);
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

    /**
     * Get the vault path (for external use like logout).
     */
    getVaultPath(): string {
        return this.config.vaultPath;
    }
}
