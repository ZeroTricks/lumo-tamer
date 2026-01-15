/**
 * Auth Manager for SRP-based authentication
 *
 * Manages authentication state, token caching, and refresh.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { logger } from '../logger.js';
import { runProtonAuth } from './go-proton-api/proton-auth-cli.js';
import type { AuthConfig, SRPAuthResult, SRPAuthTokens } from './go-proton-api/types.js';
import type { AuthTokens, Api, ApiOptions } from '../lumo-client/types.js';
import { protonConfig } from '../config.js';

export class AuthManager {
    private config: AuthConfig;
    private tokens: SRPAuthTokens | null = null;

    constructor(config: AuthConfig) {
        this.config = config;
    }

    /**
     * Initialize the auth manager by loading cached tokens or prompting for auth
     */
    async initialize(): Promise<void> {
        // Try to load cached tokens first
        if (existsSync(this.config.tokenCachePath)) {
            try {
                const cached = this.loadCachedTokens();
                if (cached && !this.isExpired(cached)) {
                    this.tokens = cached;
                    logger.info(
                        { expiresAt: cached.expiresAt },
                        'Loaded cached auth tokens'
                    );
                    return;
                }
                logger.info('Cached tokens expired, need to re-authenticate');
            } catch (err) {
                logger.warn({ err }, 'Failed to load cached tokens');
            }
        }

        // Need fresh authentication
        await this.authenticate();
    }

    /**
     * Run the Go binary to authenticate
     */
    async authenticate(): Promise<void> {
        logger.info('Starting SRP authentication (interactive)...');

        const result = await runProtonAuth(
            this.config.binaryPath,
            this.config.tokenCachePath
        );

        // If output went to file, read it back
        if (!result.accessToken && existsSync(this.config.tokenCachePath)) {
            this.tokens = this.loadCachedTokens();
        } else {
            this.tokens = {
                ...result,
                expiresAt: result.expiresAt || new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString(),
                extractedAt: new Date().toISOString(),
            };
            this.saveTokens();
        }

        logger.info('SRP authentication successful');
    }

    /**
     * Get the current tokens, ensuring they're valid
     */
    async ensureAuthenticated(): Promise<SRPAuthTokens> {
        if (!this.tokens) {
            await this.initialize();
        }

        if (!this.tokens) {
            throw new Error('Authentication failed - no tokens available');
        }

        // Check if tokens are close to expiring (within 5 minutes)
        if (this.isNearExpiry(this.tokens)) {
            logger.info('Tokens near expiry, attempting refresh...');
            try {
                await this.refresh();
            } catch (err) {
                logger.warn({ err }, 'Token refresh failed, re-authenticating...');
                await this.authenticate();
            }
        }

        return this.tokens;
    }

    /**
     * Refresh the access token using the refresh token
     */
    async refresh(): Promise<void> {
        if (!this.tokens) {
            throw new Error('No tokens to refresh');
        }

        const response = await fetch(`${protonConfig.baseUrl}/auth/refresh`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-pm-uid': this.tokens.uid,
                'x-pm-appversion': protonConfig.appVersion,
            },
            body: JSON.stringify({
                UID: this.tokens.uid,
                RefreshToken: this.tokens.refreshToken,
                ResponseType: 'token',
                GrantType: 'refresh_token',
                RedirectURI: 'https://protonmail.com',
            }),
        });

        if (!response.ok) {
            throw new Error(`Token refresh failed: ${response.status}`);
        }

        const data = await response.json() as {
            AccessToken: string;
            RefreshToken: string;
            UID: string;
            ExpiresIn?: number;
        };

        // Update tokens, preserving keyPassword
        this.tokens = {
            ...this.tokens,
            accessToken: data.AccessToken,
            refreshToken: data.RefreshToken,
            uid: data.UID,
            expiresAt: new Date(Date.now() + (data.ExpiresIn || 12 * 60 * 60) * 1000).toISOString(),
        };

        this.saveTokens();
        logger.info('Token refresh successful');
    }

    /**
     * Get the keyPassword for decrypting user keys
     */
    getKeyPassword(): string {
        if (!this.tokens) {
            throw new Error('Not authenticated - no keyPassword available');
        }
        return this.tokens.keyPassword;
    }

    /**
     * Get tokens in the format expected by createApiAdapter
     */
    getAuthTokens(): AuthTokens {
        if (!this.tokens) {
            throw new Error('Not authenticated');
        }

        // Convert SRPAuthTokens to the cookie-based AuthTokens format
        // that createApiAdapter expects
        return {
            cookies: [
                {
                    name: `AUTH-${this.tokens.uid}`,
                    value: this.tokens.accessToken,
                    domain: 'lumo.proton.me',
                    path: '/',
                    expires: new Date(this.tokens.expiresAt).getTime() / 1000,
                    httpOnly: true,
                    secure: true,
                    sameSite: 'Lax',
                },
            ],
            extractedAt: this.tokens.extractedAt,
        };
    }

    /**
     * Create an API adapter function for use with SimpleLumoClient
     */
    createApi(): Api {
        if (!this.tokens) {
            throw new Error('Not authenticated');
        }

        const tokens = this.tokens;
        const baseUrl = protonConfig.baseUrl;
        const appVersion = protonConfig.appVersion;

        return async (options: ApiOptions): Promise<ReadableStream<Uint8Array> | unknown> => {
            const url = `${baseUrl}/${options.url}`;

            const headers: Record<string, string> = {
                'Content-Type': 'application/json',
                'x-pm-uid': tokens.uid,
                'x-pm-appversion': appVersion,
                'Authorization': `Bearer ${tokens.accessToken}`,
            };

            if (options.output === 'stream') {
                headers['Accept'] = 'text/event-stream';
            }

            const fetchOptions: RequestInit = {
                method: options.method.toUpperCase(),
                headers,
                signal: options.signal,
            };

            if (options.data && options.method !== 'get') {
                fetchOptions.body = JSON.stringify(options.data);
            }

            const response = await fetch(url, fetchOptions);

            if (!response.ok) {
                const text = await response.text();
                throw new Error(`API request failed: ${response.status} ${text}`);
            }

            if (options.output === 'stream') {
                return response.body!;
            }

            return response.json();
        };
    }

    private loadCachedTokens(): SRPAuthTokens | null {
        try {
            const data = readFileSync(this.config.tokenCachePath, 'utf-8');
            return JSON.parse(data) as SRPAuthTokens;
        } catch {
            return null;
        }
    }

    private saveTokens(): void {
        if (!this.tokens) return;
        writeFileSync(
            this.config.tokenCachePath,
            JSON.stringify(this.tokens, null, 2),
            { mode: 0o600 }
        );
    }

    private isExpired(tokens: SRPAuthTokens): boolean {
        if (!tokens.expiresAt) return false;
        return new Date(tokens.expiresAt) <= new Date();
    }

    private isNearExpiry(tokens: SRPAuthTokens): boolean {
        if (!tokens.expiresAt) return false;
        const expiresAt = new Date(tokens.expiresAt);
        const fiveMinutesFromNow = new Date(Date.now() + 5 * 60 * 1000);
        return expiresAt <= fiveMinutesFromNow;
    }
}
