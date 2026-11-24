/**
 * Auth types - Unified authentication provider interface
 */

import type { ProtonApi, CachedUserKey, CachedMasterKey } from '../lumo-client/types.js';

export type AuthMethod = 'login' | 'browser' | 'rclone' | 'login-captcha';

/**
 * JSON result printed by the proton-auth Go binaries (login and login-captcha).
 */
export interface SRPAuthResult {
    accessToken: string;
    refreshToken: string;
    uid: string;
    userID: string;
    keyPassword: string;
    expiresAt?: string;
    error?: string;
    errorCode?: number;
}

/**
 * Extended auth tokens that include keyPassword (used by rclone import too).
 */
export interface SRPAuthTokens {
    accessToken: string;
    refreshToken: string;
    uid: string;
    userID: string;
    keyPassword: string;
    expiresAt: string;
    extractedAt: string;
}

/**
 * Unified token storage format
 * All auth methods read/write this format to the encrypted vault.
 */
export interface StoredTokens {
    method: AuthMethod;
    uid: string;
    accessToken: string;
    refreshToken?: string;
    keyPassword?: string;
    expiresAt?: string;
    extractedAt: string;
    // Sync data (cached from browser extraction for persistence)
    userKeys?: CachedUserKey[];
    masterKeys?: CachedMasterKey[];
}

/**
 * Status information returned by getStatus()
 */
export interface AuthProviderStatus {
    method: AuthMethod;
    source: string;
    valid: boolean;
    details: Record<string, string | number | boolean>;
    warnings: string[];
}

/**
 * Auth provider interface
 * Use AuthProvider.create() to instantiate.
 */
export interface IAuthProvider {
    readonly method: AuthMethod;

    /**
     * Get the user ID (UID)
     */
    getUid(): string;

    /**
     * Get the current access token
     */
    getAccessToken(): string;

    /**
     * Get the keyPassword for decrypting user keys (if available)
     */
    getKeyPassword(): string | undefined;

    /**
     * Create a ProtonApi function for making API calls
     */
    createApi(): ProtonApi;

    /**
     * Check if tokens are valid (not expired)
     */
    isValid(): boolean;

    /**
     * Get status information for display
     */
    getStatus(): AuthProviderStatus;

    /**
     * Refresh tokens
     */
    refresh?(): Promise<void>;

    /**
     * Get cached user keys (browser-specific, for scope bypass)
     */
    getCachedUserKeys?(): CachedUserKey[] | undefined;

    /**
     * Get cached master keys (browser-specific, for scope bypass)
     */
    getCachedMasterKeys?(): CachedMasterKey[] | undefined;

    /**
     * Whether encryption is supported (has cached userKeys and masterKeys).
     * Required for upstream storage to encrypt/decrypt conversations locally.
     */
    supportsPersistence(): boolean;

    /**
     * Whether sync to Proton servers is supported.
     * Only browser auth has the lumo scope needed for spaces API.
     */
    supportsFullApi(): boolean;

    /**
     * Get stable user ID for database naming.
     * Uses userKeys[0].ID which is stable across sessions.
     * Returns undefined if no userKeys are cached.
     */
    getUserId(): string | undefined;
}

// Re-export types that providers need
export type { ProtonApi, CachedUserKey, CachedMasterKey };
