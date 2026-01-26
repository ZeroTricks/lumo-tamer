/**
 * AuthManager - Centralized authentication token management
 *
 * Handles:
 * - Scheduled token refresh (interval-based)
 * - On-demand refresh (on 401 errors)
 * - Token refresh for all auth methods (SRP, rclone use /auth/refresh; browser re-extracts)
 * - Logout with session revocation
 */

import { logger } from '../app/logger.js';
import { createProtonApi, type ProtonApiWithRefresh } from './api-factory.js';
import { extractAndSaveTokens } from './browser/extractor.js';
import { logout as performLogout } from './logout.js';
import type { AuthProvider, ProtonApi } from './types.js';

export interface AuthManagerOptions {
    /** Auth provider instance */
    provider: AuthProvider;
    /** Path to token cache file */
    tokenCachePath: string;
    /** Auto-refresh configuration */
    autoRefresh?: {
        /** Enable scheduled refresh */
        enabled: boolean;
        /** Refresh interval in hours (default: 20 for browser, provider handles SRP/rclone) */
        intervalHours?: number;
        /** Enable refresh on 401 errors (default: true) */
        onError?: boolean;
    };
}

export class AuthManager {
    private provider: AuthProvider;
    private tokenCachePath: string;
    private autoRefreshConfig: NonNullable<AuthManagerOptions['autoRefresh']>;
    private refreshTimer?: NodeJS.Timeout;
    private protonApi?: ProtonApiWithRefresh;
    private isRefreshing = false;

    constructor(options: AuthManagerOptions) {
        this.provider = options.provider;
        this.tokenCachePath = options.tokenCachePath;
        this.autoRefreshConfig = {
            enabled: options.autoRefresh?.enabled ?? false,
            intervalHours: options.autoRefresh?.intervalHours ?? 20,
            onError: options.autoRefresh?.onError ?? true,
        };
    }

    /**
     * Get the underlying auth provider
     */
    getProvider(): AuthProvider {
        return this.provider;
    }

    /**
     * Create a ProtonApi with 401 refresh handling wired up
     */
    createApi(): ProtonApi {
        const onAuthError = this.autoRefreshConfig.onError
            ? async () => this.handleAuthError()
            : undefined;

        this.protonApi = createProtonApi({
            uid: this.provider.getUid(),
            accessToken: this.getAccessToken(),
            onAuthError,
        }) as ProtonApiWithRefresh;

        return this.protonApi;
    }

    /**
     * Start scheduled auto-refresh
     *
     * For browser auth: re-runs extraction at interval
     * For SRP/rclone: calls provider.refresh() at interval
     */
    startAutoRefresh(): void {
        if (!this.autoRefreshConfig.enabled) {
            logger.debug('Auto-refresh disabled');
            return;
        }

        const intervalHours = this.autoRefreshConfig.intervalHours ?? 20;
        const intervalMs = intervalHours * 60 * 60 * 1000;

        logger.info(
            { method: this.provider.method, intervalHours },
            'Starting scheduled token refresh'
        );

        this.refreshTimer = setInterval(async () => {
            try {
                await this.refreshNow();
            } catch (error) {
                logger.error({ error }, 'Scheduled token refresh failed');
            }
        }, intervalMs);

        // Don't prevent process exit
        this.refreshTimer.unref();
    }

    /**
     * Stop scheduled auto-refresh
     */
    stopAutoRefresh(): void {
        if (this.refreshTimer) {
            clearInterval(this.refreshTimer);
            this.refreshTimer = undefined;
            logger.info('Stopped scheduled token refresh');
        }
    }

    /**
     * Refresh tokens immediately
     *
     * - SRP/rclone: calls provider.refresh() (uses /auth/refresh endpoint)
     * - Browser: re-runs extraction from browser session
     */
    async refreshNow(): Promise<void> {
        if (this.isRefreshing) {
            logger.debug('Refresh already in progress, skipping');
            return;
        }

        this.isRefreshing = true;
        try {
            logger.info({ method: this.provider.method }, 'Refreshing tokens...');

            if (this.provider.method === 'browser') {
                // Browser auth: re-extract from browser
                await this.refreshBrowserTokens();
            } else if (this.provider.refresh) {
                // SRP/rclone: use provider's refresh method
                await this.provider.refresh();
            } else {
                throw new Error(`No refresh method available for ${this.provider.method}`);
            }

            // Update the API's credentials if we have one
            if (this.protonApi?.updateCredentials) {
                this.protonApi.updateCredentials(
                    this.provider.getUid(),
                    this.getAccessToken()
                );
            }

            logger.info({ method: this.provider.method }, 'Token refresh complete');
        } finally {
            this.isRefreshing = false;
        }
    }

    /**
     * Handle 401 auth error - attempt refresh and return new credentials
     */
    private async handleAuthError(): Promise<{ uid: string; accessToken: string } | null> {
        try {
            await this.refreshNow();
            return {
                uid: this.provider.getUid(),
                accessToken: this.getAccessToken(),
            };
        } catch (error) {
            logger.error({ error }, 'Failed to refresh tokens after 401');
            return null;
        }
    }

    /**
     * Refresh browser tokens by re-running extraction
     */
    private async refreshBrowserTokens(): Promise<void> {
        logger.info('Re-extracting browser tokens...');

        const result = await extractAndSaveTokens(this.tokenCachePath);

        // Log any warnings from extraction
        for (const warning of result.warnings) {
            logger.warn(warning);
        }

        // Re-initialize the provider to pick up new tokens
        await this.provider.initialize();

        logger.info('Browser token re-extraction complete');
    }

    /**
     * Get current access token from provider
     * (Accesses private tokens field - providers should expose this)
     */
    private getAccessToken(): string {
        // All providers store tokens internally - we need to access via createApi
        // For now, create a temporary API to get the token structure
        // This is a workaround - ideally providers would expose getAccessToken()
        const tempApi = this.provider.createApi();
        // The API closure captures uid and accessToken, but we can't access them directly
        // Instead, we rely on the fact that providers reload from cache

        // Actually, we need a better approach. Let's just re-read from the provider's internal state
        // by creating an API and extracting credentials from it.

        // For now, use a simpler approach: trust that after refresh, the provider has valid tokens
        // and createApi() will use them.

        // Return placeholder - the actual implementation needs providers to expose this
        // This will be fixed when we update the providers
        return (this.provider as unknown as { tokens?: { accessToken: string } }).tokens?.accessToken ?? '';
    }

    /**
     * Check if tokens should be refreshed proactively
     */
    shouldRefresh(): boolean {
        return this.provider.isNearExpiry() || !this.provider.isValid();
    }

    /**
     * Perform complete logout
     *
     * 1. Stops auto-refresh timer
     * 2. Revokes session on Proton servers
     * 3. Deletes local token cache
     *
     * @returns Promise that resolves when logout is complete
     */
    async logout(): Promise<void> {
        logger.info('AuthManager: Starting logout...');

        // Stop auto-refresh timer
        this.stopAutoRefresh();

        // Create API for revocation (use provider's API to ensure valid token)
        const api = this.provider.createApi();

        // Revoke session and delete tokens
        await performLogout({
            api,
            tokenCachePath: this.tokenCachePath,
            revokeRemote: true,
            deleteLocal: true,
        });

        logger.info('AuthManager: Logout complete');
    }

    /**
     * Cleanup resources
     */
    destroy(): void {
        this.stopAutoRefresh();
    }
}
