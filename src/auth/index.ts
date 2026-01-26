/**
 * Auth module - Unified authentication for all methods
 */

import { authConfig } from '../app/config.js';
import { logger } from '../app/logger.js';
import { SRPAuthProvider, BrowserAuthProvider, RcloneAuthProvider } from './providers/index.js';
import type { AuthProvider, AuthMethod, AuthProviderStatus, StoredTokens } from './types.js';

// Re-export types
export type { AuthProvider, AuthMethod, AuthProviderStatus, StoredTokens };
export type { ProtonApi, CachedUserKey, CachedMasterKey, PersistedSessionData } from './types.js';

// Re-export providers for direct use if needed
export { SRPAuthProvider, BrowserAuthProvider, RcloneAuthProvider };

// Re-export API factory
export { createProtonApi } from './api-factory.js';
export type { ApiFactoryOptions, ProtonApiWithRefresh } from './api-factory.js';

// Re-export AuthManager
export { AuthManager } from './manager.js';
export type { AuthManagerOptions } from './manager.js';

// Re-export token refresh utilities
export { refreshWithRefreshToken, canRefreshWithToken } from './token-refresh.js';

// Re-export logout utilities
export { logout, revokeSession, deleteTokenCache } from './logout.js';
export type { LogoutOptions } from './logout.js';

// Re-export browser extraction
export { extractBrowserTokens, runBrowserAuthentication } from './browser/authenticate.js';
export type { ExtractionOptions, ExtractionResult } from './browser/authenticate.js';

// Re-export extraction utilities (for scripts)
export { parseRcloneSection } from './rclone/index.js';
export { runProtonAuth } from './go-proton-api/proton-auth-cli.js';

/**
 * Create an auth provider based on current configuration
 *
 * Reads auth.method from config.yaml and creates the appropriate provider:
 * - 'srp': Uses go-proton-api binary for SRP authentication
 * - 'browser': Uses tokens extracted from browser session
 * - 'rclone': Uses tokens extracted from rclone config
 *
 * @returns Initialized AuthProvider
 */
export async function createAuthProvider(): Promise<AuthProvider> {
    const method: AuthMethod = (authConfig?.method as AuthMethod) ?? 'browser';

    logger.debug({ method }, 'Creating auth provider');

    let provider: AuthProvider;

    switch (method) {
        case 'srp':
            provider = new SRPAuthProvider();
            break;
        case 'rclone':
            provider = new RcloneAuthProvider();
            break;
        case 'browser':
        default:
            provider = new BrowserAuthProvider();
            break;
    }

    await provider.initialize();

    return provider;
}
