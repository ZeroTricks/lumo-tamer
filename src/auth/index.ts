/**
 * Auth module - Unified authentication for all methods
 */

import { authConfig } from '../config.js';
import { logger } from '../logger.js';
import { SRPAuthProvider, BrowserAuthProvider, RcloneAuthProvider } from './providers/index.js';
import type { AuthProvider, AuthMethod, AuthProviderStatus, StoredTokens } from './types.js';

// Re-export types
export type { AuthProvider, AuthMethod, AuthProviderStatus, StoredTokens };
export type { ProtonApi, CachedUserKey, CachedMasterKey, PersistedSessionData, Cookie } from './types.js';

// Re-export providers for direct use if needed
export { SRPAuthProvider, BrowserAuthProvider, RcloneAuthProvider };

// Re-export API factory
export { createProtonApi } from './api-factory.js';

// Re-export extraction utilities (for scripts)
export { parseRcloneConfig } from './rclone/index.js';
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

    logger.info({ method }, 'Creating auth provider');

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
