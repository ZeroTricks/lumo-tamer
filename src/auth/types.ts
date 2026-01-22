/**
 * Auth types - Unified authentication provider interface
 */

import type { ProtonApi, CachedUserKey, CachedMasterKey, PersistedSessionData } from '../lumo-client/types.js';

export type AuthMethod = 'srp' | 'browser' | 'rclone';

/**
 * Cookie structure for browser auth tokens
 */
export interface Cookie {
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    httpOnly: boolean;
    secure: boolean;
    sameSite: string;
}

/**
 * Unified token storage format
 * All auth methods read/write this format to sessions/auth-tokens.json
 */
export interface StoredTokens {
    method: AuthMethod;
    uid: string;
    accessToken: string;
    refreshToken?: string;
    keyPassword?: string;
    expiresAt?: string;
    extractedAt: string;
    // Browser-specific fields
    cookies?: Cookie[];
    persistedSession?: PersistedSessionData;
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
 * Unified auth provider interface
 * All auth methods (SRP, browser, rclone) implement this interface
 */
export interface AuthProvider {
    readonly method: AuthMethod;

    /**
     * Initialize the provider (load tokens, verify state)
     */
    initialize(): Promise<void>;

    /**
     * Get the user ID (UID)
     */
    getUid(): string;

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
     * Check if tokens are near expiry (within 5 minutes)
     */
    isNearExpiry(): boolean;

    /**
     * Get status information for display
     */
    getStatus(): AuthProviderStatus;

    /**
     * Refresh tokens (optional - only SRP supports this)
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
}

// Re-export types that providers need
export type { ProtonApi, CachedUserKey, CachedMasterKey, PersistedSessionData };
