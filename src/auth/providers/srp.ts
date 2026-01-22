/**
 * SRP Auth Provider
 *
 * Uses Proton's SRP protocol via go-proton-api binary.
 * Supports automatic token refresh.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { logger } from '../../logger.js';
import { protonConfig, authConfig } from '../../config.js';
import { runProtonAuth } from '../go-proton-api/proton-auth-cli.js';
import { createProtonApi } from '../api-factory.js';
import type { AuthProvider, AuthProviderStatus, StoredTokens, ProtonApi } from '../types.js';

export class SRPAuthProvider implements AuthProvider {
    readonly method = 'srp' as const;

    private tokens: StoredTokens | null = null;
    private tokenCachePath: string;
    private binaryPath: string;

    constructor() {
        this.tokenCachePath = authConfig?.tokenCachePath ?? 'sessions/auth-tokens.json';
        this.binaryPath = authConfig?.binaryPath ?? './bin/proton-auth';
    }

    async initialize(): Promise<void> {
        // Try to load cached tokens first
        if (existsSync(this.tokenCachePath)) {
            try {
                const cached = this.loadCachedTokens();
                if (cached && cached.method === 'srp' && !this.isExpired(cached)) {
                    this.tokens = cached;
                    logger.info(
                        { expiresAt: cached.expiresAt },
                        'Loaded cached SRP auth tokens'
                    );
                    return;
                }
                if (cached && cached.method === 'srp') {
                    logger.info('Cached SRP tokens expired, need to re-authenticate');
                }
            } catch (err) {
                logger.warn({ err }, 'Failed to load cached tokens');
            }
        }

        // Need fresh authentication
        await this.authenticate();
    }

    private async authenticate(): Promise<void> {
        logger.info('Starting SRP authentication (interactive)...');

        const result = await runProtonAuth(this.binaryPath, this.tokenCachePath);

        // If output went to file, read it back
        if (!result.accessToken && existsSync(this.tokenCachePath)) {
            this.tokens = this.loadCachedTokens();
        } else {
            this.tokens = {
                method: 'srp',
                uid: result.uid,
                accessToken: result.accessToken,
                refreshToken: result.refreshToken,
                keyPassword: result.keyPassword,
                expiresAt: result.expiresAt || new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString(),
                extractedAt: new Date().toISOString(),
            };
            this.saveTokens();
        }

        logger.info('SRP authentication successful');
    }

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

    getUid(): string {
        if (!this.tokens) {
            throw new Error('Not authenticated - no UID available');
        }
        return this.tokens.uid;
    }

    getKeyPassword(): string | undefined {
        return this.tokens?.keyPassword;
    }

    createApi(): ProtonApi {
        if (!this.tokens) {
            throw new Error('Not authenticated');
        }

        return createProtonApi({
            uid: this.tokens.uid,
            accessToken: this.tokens.accessToken,
        });
    }

    isValid(): boolean {
        if (!this.tokens) return false;
        return !this.isExpired(this.tokens);
    }

    isNearExpiry(): boolean {
        if (!this.tokens?.expiresAt) return false;
        const expiresAt = new Date(this.tokens.expiresAt);
        const fiveMinutesFromNow = new Date(Date.now() + 5 * 60 * 1000);
        return expiresAt <= fiveMinutesFromNow;
    }

    getStatus(): AuthProviderStatus {
        const status: AuthProviderStatus = {
            method: 'srp',
            source: this.tokenCachePath,
            valid: false,
            details: {},
            warnings: [],
        };

        if (!this.tokens) {
            status.warnings.push('No tokens loaded');
            status.warnings.push('Run: ./bin/proton-auth -o sessions/auth-tokens.json');
            return status;
        }

        status.details.uid = this.tokens.uid.slice(0, 12) + '...';
        status.details.hasKeyPassword = !!this.tokens.keyPassword;
        status.details.extractedAt = this.tokens.extractedAt;

        if (this.tokens.expiresAt) {
            const expiresAt = new Date(this.tokens.expiresAt);
            const now = new Date();
            const hoursRemaining = (expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60);

            status.details.expiresAt = this.tokens.expiresAt;

            if (hoursRemaining <= 0) {
                status.warnings.push('Tokens have expired');
                status.warnings.push('Re-run: ./bin/proton-auth -o sessions/auth-tokens.json');
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

        if (!this.tokens.keyPassword) {
            status.warnings.push('keyPassword missing - conversation persistence disabled');
        }

        return status;
    }

    private loadCachedTokens(): StoredTokens | null {
        try {
            const data = readFileSync(this.tokenCachePath, 'utf-8');
            return JSON.parse(data) as StoredTokens;
        } catch {
            return null;
        }
    }

    private saveTokens(): void {
        if (!this.tokens) return;
        writeFileSync(
            this.tokenCachePath,
            JSON.stringify(this.tokens, null, 2),
            { mode: 0o600 }
        );
    }

    private isExpired(tokens: StoredTokens): boolean {
        if (!tokens.expiresAt) return false;
        return new Date(tokens.expiresAt) <= new Date();
    }
}
