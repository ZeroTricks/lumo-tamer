/**
 * Browser Auth Provider
 *
 * Uses tokens extracted from browser session via Playwright.
 * Supports token refresh via /auth/refresh if REFRESH cookie was extracted.
 */

import { logger } from '../../app/logger.js';
import { authConfig, protonConfig, getConversationsConfig } from '../../app/config.js';
import { PROTON_URLS } from '../../app/urls.js';
import { resolveProjectPath } from '../../app/paths.js';
import { decryptPersistedSession } from '../../conversations/session-keys.js';
import { BaseAuthProvider } from './base.js';
import type { AuthProviderStatus } from '../types.js';

interface RefreshResponse {
    UID: string;
    ExpiresIn?: number;
}

export class BrowserAuthProvider extends BaseAuthProvider {
    readonly method = 'browser' as const;

    private keyPassword?: string;

    constructor() {
        super(resolveProjectPath(authConfig.tokenPath));
    }

    async initialize(): Promise<void> {
        this.tokens = this.loadTokensFromFile();
        this.validateTokens();

        const tokenAge = this.getTokenAgeHours();
        logger.debug({
            extractedAt: this.tokens.extractedAt,
            ageHours: tokenAge.toFixed(1),
            uid: this.tokens.uid.slice(0, 8) + '...',
        }, 'Browser tokens loaded');

        // Try to extract keyPassword from persisted session
        if (this.tokens.persistedSession?.blob && this.tokens.persistedSession?.clientKey) {
            try {
                const decrypted = await decryptPersistedSession(this.tokens.persistedSession);
                this.keyPassword = decrypted.keyPassword;
                logger.debug('Extracted keyPassword from browser session');
            } catch (err) {
                logger.warn({ err }, 'Failed to decrypt browser session - keyPassword unavailable');
            }
        }

        logger.debug({
            hasUserKeys: this.tokens.userKeys?.length ?? 0,
            hasMasterKeys: this.tokens.masterKeys?.length ?? 0,
        }, 'Browser provider initialized');
    }

    // Override to use extracted keyPassword instead of tokens.keyPassword
    getKeyPassword(): string | undefined {
        return this.keyPassword;
    }

    isValid(): boolean {
        if (!this.tokens?.uid || !this.tokens?.accessToken) return false;
        // Tokens typically valid for ~24h
        const ageHours = this.getTokenAgeHours();
        return ageHours < 24;
    }

    isNearExpiry(): boolean {
        if (!this.tokens) return false;
        const ageHours = this.getTokenAgeHours();
        // Consider "near expiry" if within last hour of 24h window
        return ageHours > 23;
    }

    getStatus(): AuthProviderStatus {
        const status: AuthProviderStatus = {
            method: 'browser',
            source: this.tokenCachePath,
            valid: false,
            details: {},
            warnings: [],
        };

        if (!this.tokens) {
            status.warnings.push(`Token file not found: ${this.tokenCachePath}`);
            status.warnings.push('Run: npm run extract-tokens');
            return status;
        }

        status.details.extractedAt = this.tokens.extractedAt;
        status.details.hasPersistedSession = !!this.tokens.persistedSession;

        const ageHours = this.getTokenAgeHours();
        status.details.age = this.formatDuration(ageHours);

        if (!this.isValid()) {
            status.warnings.push('Tokens likely expired (>24h old)');
            status.warnings.push('Run: npm run extract-tokens');
        } else {
            status.valid = true;
        }

        // Show UID
        if (this.tokens.uid) {
            status.details.uid = this.tokens.uid.slice(0, 12) + '...';
        }

        // Check keyPassword availability (only warn if sync is enabled)
        status.details.hasKeyPassword = !!this.keyPassword;
        const syncEnabled = getConversationsConfig()?.sync?.enabled ?? false;
        if (!this.keyPassword && syncEnabled) {
            if (!this.tokens.persistedSession?.blob) {
                status.warnings.push('No persisted session blob found');
            }
            if (!this.tokens.persistedSession?.clientKey) {
                status.warnings.push('No clientKey available - run npm run auth');
            }
        }

        return status;
    }

    supportsPersistence(): boolean {
        return true;
    }

    /**
     * Browser-specific token refresh using cookie-based approach.
     *
     * Unlike SRP/rclone which use JSON body, browser auth must send the refresh
     * token as a cookie and parse new tokens from Set-Cookie response headers.
     */
    async refresh(): Promise<void> {
        if (!this.tokens?.refreshToken) {
            throw new Error('No refresh token available');
        }

        const baseUrl = PROTON_URLS.LUMO_API;
        const clientId = 'WebLumo';

        // Reconstruct the REFRESH cookie value as the browser would send it
        const refreshCookieValue = encodeURIComponent(JSON.stringify({
            ResponseType: 'token',
            ClientID: clientId,
            GrantType: 'refresh_token',
            RefreshToken: this.tokens.refreshToken,
            UID: this.tokens.uid,
        }));
        const refreshCookie = `REFRESH-${this.tokens.uid}=${refreshCookieValue}`;

        logger.info({
            uid: this.tokens.uid.slice(0, 8) + '...',
            clientId,
            baseUrl,
        }, 'Refreshing browser tokens via /auth/refresh (cookie-based)');

        const response = await fetch(`${baseUrl}/auth/refresh`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-pm-uid': this.tokens.uid,
                'x-pm-appversion': protonConfig.appVersion,
                'Cookie': refreshCookie,
            },
        });

        if (!response.ok) {
            const errorBody = await response.text().catch(() => '');
            logger.error(
                { status: response.status, body: errorBody.slice(0, 200) },
                'Browser token refresh failed'
            );
            throw new Error(`Token refresh failed: ${response.status}`);
        }

        // Parse tokens from Set-Cookie headers
        const setCookieHeaders = response.headers.getSetCookie?.() || [];
        logger.debug({ setCookieHeaders }, 'Refresh response cookies');

        let newAccessToken: string | undefined;
        let newRefreshToken: string | undefined;

        for (const cookie of setCookieHeaders) {
            // AUTH-{uid}=<accessToken>; ...
            const authMatch = cookie.match(/^AUTH-[^=]+=([^;]+)/);
            if (authMatch) {
                newAccessToken = authMatch[1];
            }

            // REFRESH-{uid}=<url-encoded json>; ...
            const refreshMatch = cookie.match(/^REFRESH-[^=]+=([^;]+)/);
            if (refreshMatch) {
                try {
                    const decoded = JSON.parse(decodeURIComponent(refreshMatch[1]));
                    newRefreshToken = decoded.RefreshToken;
                } catch {
                    logger.warn({ cookie: refreshMatch[1].slice(0, 50) }, 'Failed to parse REFRESH cookie');
                }
            }
        }

        // Also check JSON body for ExpiresIn
        const data = await response.json() as RefreshResponse;

        if (!newAccessToken) {
            logger.error({
                data,
                setCookieCount: setCookieHeaders.length,
            }, 'No access token in refresh response cookies');
            throw new Error('No access token in refresh response');
        }

        const expiresIn = data.ExpiresIn || 12 * 60 * 60; // Default 12 hours

        // Update tokens
        this.tokens = {
            ...this.tokens,
            accessToken: newAccessToken,
            refreshToken: newRefreshToken || this.tokens.refreshToken,
            uid: data.UID || this.tokens.uid,
            expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
            extractedAt: new Date().toISOString(), // Reset age on refresh
        };

        this.saveTokensToFile();

        logger.info({
            method: this.method,
            uid: this.tokens.uid.slice(0, 8) + '...',
            expiresIn: `${Math.round(expiresIn / 3600)}h`,
        }, 'Browser token refresh successful');
    }

    // === Browser-specific helpers ===

    private getTokenAgeHours(): number {
        if (!this.tokens?.extractedAt) return 0;
        const extractedAt = new Date(this.tokens.extractedAt).getTime();
        return (Date.now() - extractedAt) / (1000 * 60 * 60);
    }

    private formatDuration(hours: number): string {
        if (hours < 1) {
            return `${Math.round(hours * 60)} minutes`;
        } else if (hours < 24) {
            return `${hours.toFixed(1)} hours`;
        } else {
            return `${(hours / 24).toFixed(1)} days`;
        }
    }
}
