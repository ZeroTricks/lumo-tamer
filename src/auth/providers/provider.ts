/**
 * AuthProvider - Unified auth provider for all methods
 *
 * Provides:
 * - Static factory: create() - Load tokens, return appropriate provider
 * - getStatus() - Status reporting
 * - isValid() - Token validity checking
 * - supportsPersistence() - Data-driven persistence capability
 * - Token getters (uid, accessToken, keyPassword, cached keys)
 * - API creation
 * - Token vault I/O (AES-256-GCM encrypted)
 * - Token refresh (BrowserAuthProvider overrides for cookie-based refresh)
 */

import { existsSync } from 'fs';
import { logger } from '../../app/logger.js';
import { authConfig, getConversationsConfig } from '../../app/config.js';
import { resolveProjectPath } from '../../app/paths.js';
import { createProtonApi } from '../api-factory.js';
import { refreshWithRefreshToken, canRefreshWithToken } from '../token-refresh.js';
import { readVault, writeVault } from '../vault/index.js';
import type { VaultKeyConfig } from '../vault/index.js';
import type {
    IAuthProvider,
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

/**
 * Get provider config from authConfig.
 */
export function getProviderConfig(): ProviderConfig {
    return {
        vaultPath: resolveProjectPath(authConfig.vault.path),
        keyConfig: {
            keychain: authConfig.vault.keychain,
            keyFilePath: authConfig.vault.keyFilePath,
        },
    };
}

// Factory function type for creating browser provider (avoids circular import)
type BrowserProviderFactory = (tokens: StoredTokens, config: ProviderConfig) => AuthProvider;

// Will be set by browser.ts on import
let browserProviderFactory: BrowserProviderFactory | null = null;

/**
 * Register the browser provider factory (called by browser.ts)
 */
export function registerBrowserProvider(factory: BrowserProviderFactory): void {
    browserProviderFactory = factory;
}

export class AuthProvider implements IAuthProvider {
    readonly method: AuthMethod;
    protected tokens: StoredTokens;
    protected config: ProviderConfig;

    /**
     * Create an auth provider by loading tokens from vault.
     * Returns BrowserAuthProvider for browser method, AuthProvider otherwise.
     */
    static async create(): Promise<AuthProvider> {
        const config = getProviderConfig();

        if (!existsSync(config.vaultPath)) {
            throw new Error(
                `Vault not found: ${config.vaultPath}\n` +
                'Run: tamer auth'
            );
        }

        const tokens = await readVault(config.vaultPath, config.keyConfig);

        // Validate required fields
        if (!tokens.uid || !tokens.accessToken) {
            throw new Error(
                'Token file missing uid or accessToken.\n' +
                'Run: tamer auth'
            );
        }

        // Create appropriate provider
        let provider: AuthProvider;
        if (tokens.method === 'browser' && browserProviderFactory) {
            provider = browserProviderFactory(tokens, config);
        } else {
            provider = new AuthProvider(tokens, config);
        }

        // Refresh if expired
        await provider.refreshIfNeeded();

        // Log loaded tokens
        logger.debug({
            method: provider.method,
            uid: tokens.uid.slice(0, 8) + '...',
            extractedAt: tokens.extractedAt,
            expiresAt: tokens.expiresAt || 'unavailable',
            hasKeyPassword: !!tokens.keyPassword,
            hasUserKeys: tokens.userKeys?.length ?? 0,
            hasMasterKeys: tokens.masterKeys?.length ?? 0,
        }, 'Auth tokens loaded');

        return provider;
    }

    constructor(tokens: StoredTokens, config: ProviderConfig) {
        this.tokens = tokens;
        this.method = tokens.method || 'browser'; // Default for legacy vaults
        this.config = config;
    }

    // === Status reporting ===

    getStatus(): AuthProviderStatus {
        const status: AuthProviderStatus = {
            method: this.method,
            source: this.config.vaultPath,
            valid: false,
            details: {},
            warnings: [],
        };

        // Common details
        status.details.uid = this.tokens.uid.slice(0, 12) + '...';
        status.details.extractedAt = this.tokens.extractedAt;
        status.details.hasKeyPassword = !!this.tokens.keyPassword;

        // Expiry status
        if (this.tokens.expiresAt) {
            const expiresAt = new Date(this.tokens.expiresAt);
            const now = new Date();
            const hoursRemaining = (expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60);

            if (hoursRemaining <= 0) {
                status.warnings.push('Tokens have expired');
                status.warnings.push('Run: tamer auth');
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

        // keyPassword warning - only if sync is enabled
        const syncEnabled = getConversationsConfig().sync.enabled;
        if (!this.tokens.keyPassword && syncEnabled) {
            status.warnings.push('keyPassword missing - conversation persistence disabled');
        }

        return status;
    }

    // === Token validity ===

    isValid(): boolean {
        if (!this.tokens.uid || !this.tokens.accessToken) return false;
        return !this.isExpired();
    }

    protected isExpired(): boolean {
        if (!this.tokens.expiresAt) return false;
        return new Date(this.tokens.expiresAt) <= new Date();
    }

    // === Token refresh ===

    /**
     * Refresh tokens if expired.
     */
    protected async refreshIfNeeded(): Promise<void> {
        if (!this.tokens.expiresAt) return;

        if (new Date(this.tokens.expiresAt) <= new Date()) {
            logger.info({ method: this.method }, 'Access token expired, refreshing...');
            await this.refresh();
        }
    }

    /**
     * Refresh tokens using /auth/refresh endpoint.
     * BrowserAuthProvider overrides for cookie-based refresh.
     */
    async refresh(): Promise<void> {
        if (!canRefreshWithToken(this.tokens)) {
            throw new Error('No refresh token available');
        }

        const refreshed = await refreshWithRefreshToken(this.tokens);
        this.tokens = { ...this.tokens, ...refreshed };

        await this.saveTokensToVault();

        logger.info({
            method: this.method,
            hasAccessToken: !!this.tokens.accessToken,
            hasRefreshToken: !!this.tokens.refreshToken,
        }, 'Token refresh successful');
    }

    // === Token getters ===

    getUid(): string {
        return this.tokens.uid;
    }

    getAccessToken(): string {
        return this.tokens.accessToken;
    }

    getKeyPassword(): string | undefined {
        return this.tokens.keyPassword;
    }

    getCachedUserKeys(): CachedUserKey[] | undefined {
        return this.tokens.userKeys;
    }

    getCachedMasterKeys(): CachedMasterKey[] | undefined {
        return this.tokens.masterKeys;
    }

    // === API creation ===

    createApi(): ProtonApi {
        return createProtonApi({
            uid: this.tokens.uid,
            accessToken: this.tokens.accessToken,
        });
    }

    // === Vault I/O ===

    protected async saveTokensToVault(): Promise<void> {
        const { vaultPath, keyConfig } = this.config;
        await writeVault(vaultPath, this.tokens, keyConfig);
    }

    getVaultPath(): string {
        return this.config.vaultPath;
    }

    // === Persistence & Sync ===

    /**
     * Check if local encryption is supported.
     * Data-driven: returns true if vault contains cached userKeys and masterKeys.
     * Required for upstream storage to encrypt/decrypt conversations locally.
     */
    supportsPersistence(): boolean {
        return !!(this.tokens.userKeys?.length && this.tokens.masterKeys?.length);
    }

    /**
     * Check if sync to Proton servers is supported.
     * Only browser auth has the lumo scope needed for spaces API.
     */
    supportsSync(): boolean {
        return this.method === 'browser';
    }

    /**
     * Get stable user ID for database naming.
     * Uses userKeys[0].ID which is stable across sessions.
     * Returns undefined if no userKeys are cached.
     */
    getUserId(): string | undefined {
        return this.tokens.userKeys?.[0]?.ID;
    }
}
