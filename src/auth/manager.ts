/**
 * AuthManager - Centralized authentication token management
 *
 * Handles:
 * - Scheduled token refresh (interval-based)
 * - On-demand refresh (on 401 errors)
 * - Token refresh for all auth methods (all use /auth/refresh endpoint)
 * - Logout with session revocation
 */

import { logger } from '../app/logger.js';
import { createProtonApi, type ProtonApiWithRefresh } from './api-factory.js';
import { logout as performLogout } from './logout.js';
import type { IAuthProvider, ProtonApi } from './types.js';

export interface AuthManagerOptions {
    /** Auth provider instance */
    provider: IAuthProvider;
    /** Path to the encrypted vault file */
    vaultPath: string;
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
    private provider: IAuthProvider;
    private vaultPath: string;
    private autoRefreshConfig: NonNullable<AuthManagerOptions['autoRefresh']>;
    private refreshTimer?: NodeJS.Timeout;
    private protonApi?: ProtonApiWithRefresh;
    private isRefreshing = false;

    constructor(options: AuthManagerOptions) {
        this.provider = options.provider;
        this.vaultPath = options.vaultPath;
        this.autoRefreshConfig = {
            enabled: options.autoRefresh?.enabled ?? false,
            intervalHours: options.autoRefresh?.intervalHours ?? 20,
            onError: options.autoRefresh?.onError ?? true,
        };
    }

    /**
     * Get the underlying auth provider
     */
    getProvider(): IAuthProvider {
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
     * All auth methods call provider.refresh() at interval.
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
     * All auth methods now use provider.refresh() which calls /auth/refresh endpoint.
     */
    async refreshNow(): Promise<void> {
        if (this.isRefreshing) {
            logger.debug('Refresh already in progress, skipping');
            return;
        }

        this.isRefreshing = true;
        try {
            logger.info({ method: this.provider.method }, 'Refreshing tokens...');

            if (this.provider.refresh) {
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
     * Get current access token from provider
     */
    private getAccessToken(): string {
        return this.provider.getAccessToken();
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
            vaultPath: this.vaultPath,
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
