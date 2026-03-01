/**
 * Auth module - Unified authentication for all methods
 */

import { AuthProvider } from './providers/index.js';

// Re-export types
export type { AuthMethod, AuthProviderStatus, CachedMasterKey, CachedUserKey, IAuthProvider, ProtonApi, StoredTokens } from './types.js';

// Re-export provider class (use AuthProvider.create() to instantiate)
export { AuthProvider, BrowserAuthProvider } from './providers/index.js';

// Re-export API factory
export { createProtonApi } from './api-factory.js';
export type { ApiFactoryOptions, ProtonApiWithRefresh } from './api-factory.js';

// Re-export AuthManager
export { AuthManager } from './manager.js';
export type { AuthManagerOptions } from './manager.js';

// Re-export token refresh utilities
export { canRefreshWithToken, refreshWithRefreshToken } from './token-refresh.js';

// Re-export logout utilities
export { deleteTokenCache, logout, revokeSession } from './logout.js';
export type { LogoutOptions } from './logout.js';

// Re-export browser extraction
export { extractBrowserTokens, runBrowserAuthentication } from './browser/authenticate.js';
export type { ExtractionOptions, ExtractionResult } from './browser/authenticate.js';

// Re-export extraction utilities (for scripts)
export { runProtonAuth } from './login/proton-auth-cli.js';
export { parseRcloneSection } from './rclone/index.js';

/**
 * Create an auth provider by loading tokens from vault.
 * Delegates to AuthProvider.create() static factory.
 */
export async function createAuthProvider(): Promise<AuthProvider> {
    return AuthProvider.create();
}
